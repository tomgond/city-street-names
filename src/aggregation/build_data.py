#!/usr/bin/env python3
"""
Processing Pipeline for City Street Names Analysis

This script loads normalized street data and builds similarity metrics between cities
based on shared street names.
"""

import csv
import json
import logging
import math
import os
import shutil
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx

# Allow running the script directly without requiring PYTHONPATH tweaks
ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from src.normalization.norm_data import normalize_name

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class StreetProcessingPipeline:
    def __init__(self):
        self.cities_data = defaultdict(dict)
        self.city_street_meta = defaultdict(dict)
        self.street_to_cities = defaultdict(set)
        self.norm_keys = {}
        self.norm_display_counts = defaultdict(Counter)
        self.rarity_weights = {}
        self.city_names = {}
        self.city_communities = {}
        self.city_name_graph = {}

    def load_data(self, csv_path):
        """Load street data from CSV file."""
        logger.info("Loading data from {}".format(csv_path))
        start_time = time.time()

        with open(csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                city_code = int(row['city_code'])
                city_name = row['city_name']
                norm_key = row['norm_key']
                norm_display = row['norm_display']
                street_name = (row.get('street_name') or '').strip()
                street_code = (row.get('street_code') or '').strip()

                display_value = street_name or norm_display

                if city_code not in self.city_names:
                    self.city_names[city_code] = city_name

                self.cities_data[city_code][norm_key] = norm_display

                street_meta = self.city_street_meta[city_code].get(norm_key)
                if street_meta is None:
                    self.city_street_meta[city_code][norm_key] = {
                        'display': display_value,
                        'norm_display': norm_display,
                        'street_code': street_code
                    }
                else:
                    if street_meta['display'] == street_meta['norm_display'] and display_value != norm_display:
                        street_meta['display'] = display_value
                    if not street_meta.get('street_code') and street_code:
                        street_meta['street_code'] = street_code

                self.norm_display_counts[norm_key][display_value] += 1

                if norm_key not in self.norm_keys:
                    self.norm_keys[norm_key] = display_value

                self.street_to_cities[norm_key].add(city_code)

        for norm_key, counter in self.norm_display_counts.items():
            if counter:
                preferred, _ = counter.most_common(1)[0]
                self.norm_keys[norm_key] = preferred

        load_time = time.time() - start_time
        logger.info("Loaded data in %.2fs", load_time)
        return self

    def compute_rarity_weights(self):
        """Compute rarity weights for each normalized street key."""
        logger.info("Computing rarity weights")
        start_time = time.time()

        for norm_key, cities in self.street_to_cities.items():
            df = len(cities)
            self.rarity_weights[norm_key] = 1.0 / math.log(1 + df)

        compute_time = time.time() - start_time
        logger.info("Computed rarity weights in %.2fs", compute_time)
        return self

    def calculate_jaccard_similarity(self, city_a_streets, city_b_streets):
        """Calculate Jaccard similarity between two cities' street sets."""
        intersection = city_a_streets & city_b_streets
        union = city_a_streets | city_b_streets

        if not union:
            return 0.0

        return len(intersection) / len(union)

    def calculate_weighted_jaccard_similarity(self, city_a_streets, city_b_streets):
        """Calculate weighted Jaccard similarity between two cities' street sets."""
        intersection = city_a_streets & city_b_streets
        union = city_a_streets | city_b_streets

        if not union:
            return 0.0

        intersection_weight = sum(self.rarity_weights.get(street, 0.0) for street in intersection)
        union_weight = sum(self.rarity_weights.get(street, 0.0) for street in union)

        return intersection_weight / union_weight if union_weight > 0 else 0.0

    def get_top_shared_streets(self, city_a_streets, city_b_streets, top_n=10):
        """Get top shared streets by rarity weight."""
        intersection = city_a_streets & city_b_streets

        # Sort by rarity weight descending
        sorted_streets = sorted(
            intersection,
            key=lambda s: self.rarity_weights.get(s, 0.0),
            reverse=True
        )

        return [
            {
                'norm_key': street,
                'display_name': self.norm_keys[street],
                'rarity_weight': self.rarity_weights.get(street, 0.0)
            }
            for street in sorted_streets[:top_n]
        ]

    def detect_communities(self, similarity_top, metric='weightedJaccard', min_weight=0.0):
        """Detect communities using NetworkX community detection algorithms."""
        logger.info("Detecting city communities using NetworkX (metric=%s)", metric)
        start_time = time.time()

        graph = nx.Graph()
        for city_code in self.city_names:
            graph.add_node(str(city_code))

        metric_key = metric or 'weightedJaccard'
        valid_metrics = {'weightedJaccard', 'jaccard', 'weighted_jaccard'}
        if metric_key not in valid_metrics:
            logger.warning(
                "Unsupported community metric '%s'; defaulting to weightedJaccard",
                metric_key
            )
            metric_key = 'weightedJaccard'

        if metric_key == 'weighted_jaccard':
            metric_key = 'weightedJaccard'

        edge_weights = defaultdict(float)
        for source, neighbors in (similarity_top or {}).items():
            source_id = str(source)
            if not neighbors:
                continue
            for entry in neighbors:
                target_raw = entry.get('city')
                if target_raw is None:
                    continue
                target_id = str(target_raw)
                if target_id == source_id:
                    continue
                weight = float(entry.get(metric_key) or 0.0)
                if weight <= min_weight:
                    continue
                edge_key = tuple(sorted((source_id, target_id)))
                if weight > edge_weights[edge_key]:
                    edge_weights[edge_key] = weight

        for (node_a, node_b), weight in edge_weights.items():
            graph.add_edge(node_a, node_b, weight=weight)

        if graph.number_of_nodes() == 0:
            self.city_communities = {}
            logger.warning("No cities available for community detection")
            return self

        if graph.number_of_edges() == 0:
            logger.warning("Graph has no edges; assigning each city to its own community")
            community_groups = [[node] for node in sorted(graph.nodes)]
        else:
            try:
                communities_iter = nx.algorithms.community.louvain_communities(
                    graph,
                    weight='weight',
                    seed=42
                )
                community_groups = [sorted(map(str, group)) for group in communities_iter if group]
            except AttributeError:
                from networkx.algorithms import community as nx_community

                communities_iter = nx_community.greedy_modularity_communities(
                    graph,
                    weight='weight'
                )
                community_groups = [sorted(map(str, group)) for group in communities_iter if group]

            assigned_nodes = {node for group in community_groups for node in group}
            unassigned = sorted(set(graph.nodes) - assigned_nodes)
            community_groups.extend([[node] for node in unassigned])

        community_groups.sort(key=lambda group: (-len(group), group[0]))

        community_lookup = {}
        for community_id, members in enumerate(community_groups):
            for member in members:
                community_lookup[member] = community_id

        self.city_communities = community_lookup
        elapsed = time.time() - start_time
        logger.info(
            "Detected %d communities in %.2fs",
            len(community_groups),
            elapsed
        )

        return self

    def build_city_name_honor_graph(self):
        """Build a directed graph of cities that name streets after other cities."""
        logger.info("Building city honor graph based on street names")
        start_time = time.time()

        city_key_to_codes = defaultdict(set)
        city_display_by_code = {}

        def _city_name_lookup(raw_code):
            try:
                return self.city_names.get(int(raw_code), '')
            except (TypeError, ValueError):
                return self.city_names.get(raw_code, '')

        for code, name in self.city_names.items():
            normalized = normalize_name(name, drop_he=False)
            city_display_by_code[code] = normalized["display"] or name
            key = normalized["key"]
            if key:
                city_key_to_codes[key].add(code)

            dropped = normalize_name(name, drop_he=True)
            dropped_key = dropped["key"]
            if dropped_key and dropped_key != key:
                city_key_to_codes[dropped_key].add(code)

        edges = {}
        active_cities = set()

        for source_code, streets in self.city_street_meta.items():
            for norm_key, meta in streets.items():
                target_codes = city_key_to_codes.get(norm_key)
                if not target_codes:
                    continue
                for target_code in target_codes:
                    if target_code == source_code:
                        continue
                    edge_key = (str(source_code), str(target_code))
                    street_record = {
                        'normKey': norm_key,
                        'display': meta.get('display') or self.norm_keys.get(norm_key, norm_key),
                        'normDisplay': meta.get('norm_display') or self.cities_data[source_code].get(norm_key, ''),
                        'streetCode': meta.get('street_code', '')
                    }
                    entry = edges.setdefault(edge_key, {
                        'source': edge_key[0],
                        'target': edge_key[1],
                        'streets': []
                    })
                    entry['streets'].append(street_record)
                    active_cities.update(edge_key)

        if not edges:
            self.city_name_graph = {
                'nodes': [],
                'links': [],
                'stats': {
                    'cityCount': 0,
                    'edgeCount': 0,
                    'streetReferenceCount': 0,
                    'longestPath': None,
                    'longestCycle': None
                }
            }
            logger.warning("No inter-city honor edges detected")
            return self

        def _collect_edge_details(sequence):
            details = []
            for src, dst in zip(sequence, sequence[1:]):
                edge_info = edges.get((src, dst))
                if not edge_info:
                    continue
                details.append({
                    'source': src,
                    'target': dst,
                    'streetCount': len(edge_info['streets']),
                    'streetNames': [street['display'] for street in edge_info['streets']]
                })
            return details

        analysis_adjacency = defaultdict(list)
        for (src, dst), data in edges.items():
            weight = len(data['streets'])
            analysis_adjacency[src].append((dst, weight))

        trimmed_adjacency = {}
        analysis_limit = 4
        for source, neighbors in analysis_adjacency.items():
            if not neighbors:
                continue
            sorted_neighbors = sorted(neighbors, key=lambda item: item[1], reverse=True)[:analysis_limit]
            trimmed_adjacency[source] = sorted_neighbors

        for node in active_cities:
            trimmed_adjacency.setdefault(node, [])

        longest_path = []
        max_states = 250000
        state_counter = 0

        for start in active_cities:
            if state_counter >= max_states:
                break
            stack = [(start, [start], {start})]
            while stack:
                node, path, visited = stack.pop()
                state_counter += 1
                if len(path) > len(longest_path):
                    longest_path = list(path)
                if state_counter >= max_states:
                    logger.warning(
                        "Longest path search hit state cap (%d); partial result length=%d",
                        max_states,
                        len(longest_path)
                    )
                    stack = []
                    break
                for neighbor, _ in trimmed_adjacency.get(node, []):
                    if neighbor in visited:
                        continue
                    stack.append((neighbor, path + [neighbor], visited | {neighbor}))

        digraph = nx.DiGraph()
        digraph.add_nodes_from(active_cities)
        for (src, dst), data in edges.items():
            digraph.add_edge(src, dst, weight=len(data['streets']))

        cycle_entry = None
        path_entry = None

        if len(longest_path) > 1:
            path_details = _collect_edge_details(longest_path)
            path_entry = {
                'length': len(longest_path),
                'cities': list(longest_path),
                'cityNames': [_city_name_lookup(code) for code in longest_path],
                'edges': path_details
            }

        analysis_graph = nx.DiGraph()
        analysis_graph.add_nodes_from(active_cities)
        for source, neighbors in trimmed_adjacency.items():
            for target, _ in neighbors:
                analysis_graph.add_edge(source, target)

        try:
            longest_cycle_nodes = []
            cycle_cap = 5000
            for index, cycle_nodes in enumerate(nx.simple_cycles(analysis_graph), start=1):
                if len(cycle_nodes) > len(longest_cycle_nodes):
                    longest_cycle_nodes = cycle_nodes
                if index >= cycle_cap:
                    logger.warning(
                        "Cycle enumeration hit cap (%d); best cycle length=%d",
                        cycle_cap,
                        len(longest_cycle_nodes)
                    )
                    break
        except nx.NetworkXNoCycle:
            longest_cycle_nodes = []

        if longest_cycle_nodes:
            cycle_sequence = list(longest_cycle_nodes) + [longest_cycle_nodes[0]]
            cycle_details = _collect_edge_details(cycle_sequence)
            cycle_entry = {
                'length': len(cycle_sequence) - 1,
                'cities': list(cycle_sequence),
                'cityNames': [_city_name_lookup(code) for code in cycle_sequence],
                'edges': cycle_details
            }

        out_counts = Counter()
        in_counts = Counter()
        out_streets = Counter()
        in_streets = Counter()

        for (src, dst), data in edges.items():
            out_counts[src] += 1
            in_counts[dst] += 1
            street_total = len(data['streets'])
            out_streets[src] += street_total
            in_streets[dst] += street_total

        nodes_output = []
        total_street_refs = 0
        for code in sorted(active_cities, key=lambda cid: _city_name_lookup(cid)):
            try:
                numeric_code = int(code)
            except (TypeError, ValueError):
                numeric_code = code
            street_count = len(self.cities_data.get(numeric_code, {}))
            honor_out = out_counts.get(code, 0)
            honor_in = in_counts.get(code, 0)
            honor_out_streets = out_streets.get(code, 0)
            honor_in_streets = in_streets.get(code, 0)
            total_street_refs += honor_out_streets
            nodes_output.append({
                'id': code,
                'name': _city_name_lookup(code),
                'displayName': city_display_by_code.get(numeric_code, _city_name_lookup(code)),
                'streetCount': street_count,
                'honorsOut': honor_out,
                'honorsIn': honor_in,
                'honorStreetOut': honor_out_streets,
                'honorStreetIn': honor_in_streets
            })

        links_output = []
        for (src, dst), data in sorted(edges.items(), key=lambda item: (item[0][0], item[0][1])):
            links_output.append({
                'source': src,
                'target': dst,
                'streetCount': len(data['streets']),
                'streets': data['streets']
            })

        self.city_name_graph = {
            'nodes': nodes_output,
            'links': links_output,
            'stats': {
                'cityCount': len(active_cities),
                'edgeCount': len(links_output),
                'streetReferenceCount': total_street_refs,
                'longestPath': path_entry,
                'longestCycle': cycle_entry
            }
        }

        elapsed = time.time() - start_time
        logger.info(
            "City honor graph ready: %d nodes, %d edges (%.2fs)",
            len(nodes_output),
            len(links_output),
            elapsed
        )

        return self

    def calculate_city_similarities(self):
        """Calculate similarities between all city pairs."""
        logger.info("Calculating city similarities")
        start_time = time.time()

        city_codes = list(self.cities_data.keys())
        total_combinations = len(city_codes) * (len(city_codes) - 1) // 2

        base_pairs = []
        processed = 0

        for i, city_a in enumerate(city_codes):
            city_a_streets = set(self.cities_data[city_a].keys())
            for city_b in city_codes[i + 1:]:
                city_b_streets = set(self.cities_data[city_b].keys())

                intersection = city_a_streets & city_b_streets
                if not intersection:
                    processed += 1
                    continue

                union = city_a_streets | city_b_streets

                jaccard = self.calculate_jaccard_similarity(city_a_streets, city_b_streets)
                weighted_jaccard = self.calculate_weighted_jaccard_similarity(city_a_streets, city_b_streets)
                top_streets = self.get_top_shared_streets(city_a_streets, city_b_streets, top_n=10)

                base_pairs.append({
                    'city_a': city_a,
                    'city_b': city_b,
                    'jaccard': round(jaccard, 4),
                    'weighted_jaccard': round(weighted_jaccard, 4),
                    'intersection_size': len(intersection),
                    'union_size': len(union),
                    'top_shared_streets': top_streets,
                })

                processed += 1
                if processed % 10000 == 0:
                    logger.info("Processed %d/%d city combinations", processed, total_combinations)

        similarities = {}
        for pair in base_pairs:
            city_a = pair['city_a']
            city_b = pair['city_b']

            shared_payload = {
                'jaccard': pair['jaccard'],
                'weighted_jaccard': pair['weighted_jaccard'],
                'intersection_size': pair['intersection_size'],
                'union_size': pair['union_size'],
                'top_shared_streets': list(pair['top_shared_streets']),
            }

            key_ab = f"{city_a}_{city_b}"
            key_ba = f"{city_b}_{city_a}"

            similarities[key_ab] = {
                **shared_payload,
                'city_a': city_a,
                'city_b': city_b,
            }

            similarities[key_ba] = {
                **shared_payload,
                'city_a': city_b,
                'city_b': city_a,
            }

        calc_time = time.time() - start_time
        logger.info(
            "Calculated %d non-zero similarity pairs (out of %d combinations) in %.2fs",
            len(base_pairs),
            total_combinations,
            calc_time,
        )

        return similarities, base_pairs

    def export_data(self, output_dir, similarities=None, top_similarities=None):
        """Export processed data to JSON files."""
        logger.info("Exporting data to %s", output_dir)
        os.makedirs(output_dir, exist_ok=True)

        # Prepare per-city records
        cities_output = []
        for city_code, streets in self.cities_data.items():
            city_meta = self.city_street_meta.get(city_code, {})
            sorted_keys = sorted(streets.keys(), key=lambda key: city_meta.get(key, {}).get('display', streets[key]))
            city_entry = {
                'id': str(city_code),
                'name': self.city_names.get(city_code, ''),
                'streetCount': len(streets),
                'streets': []
            }

            community = self.city_communities.get(str(city_code))
            if community is not None:
                city_entry['community'] = community

            for key in sorted_keys:
                info = city_meta.get(key, {})
                city_entry['streets'].append({
                    'key': key,
                    'display': info.get('display', self.norm_keys.get(key, key)),
                    'normDisplay': info.get('norm_display', streets[key]),
                    'streetCode': info.get('street_code', ''),
                    'rarityWeight': round(self.rarity_weights.get(key, 0.0), 6)
                })

            cities_output.append(city_entry)

        cities_output.sort(key=lambda city: city['name'])

        with open(os.path.join(output_dir, 'cities.json'), 'w', encoding='utf-8') as f:
            json.dump(cities_output, f, indent=2, ensure_ascii=False)

        # Build an index of streets to cities with metadata
        street_index_output = {}
        for street_key, cities in self.street_to_cities.items():
            sorted_cities = sorted(cities, key=lambda code: self.city_names.get(code, ''))
            street_index_output[street_key] = {
                'display': self.norm_keys.get(street_key, street_key),
                'rarityWeight': round(self.rarity_weights.get(street_key, 0.0), 6),
                'cityCount': len(sorted_cities),
                'cities': []
            }

            for code in sorted_cities:
                city_info = self.city_street_meta.get(code, {}).get(street_key, {})
                street_index_output[street_key]['cities'].append({
                    'id': str(code),
                    'name': self.city_names.get(code, ''),
                    'streetCount': len(self.cities_data[code]),
                    'streetDisplay': city_info.get('display', self.norm_keys.get(street_key, street_key)),
                    'normDisplay': city_info.get('norm_display')
                })

        with open(os.path.join(output_dir, 'street_index.json'), 'w', encoding='utf-8') as f:
            json.dump(street_index_output, f, indent=2, ensure_ascii=False)

        # Export rarity weights for analytics that still rely on the standalone file
        with open(os.path.join(output_dir, 'rarity_weights.json'), 'w', encoding='utf-8') as f:
            json.dump(self.rarity_weights, f, indent=2, ensure_ascii=False)

        if self.city_name_graph:
            with open(os.path.join(output_dir, 'city_name_graph.json'), 'w', encoding='utf-8') as f:
                json.dump(self.city_name_graph, f, indent=2, ensure_ascii=False)

        # Export similarity top lists for light-weight analytics
        if top_similarities is not None:
            with open(os.path.join(output_dir, 'similarity_top.json'), 'w', encoding='utf-8') as f:
                json.dump(top_similarities, f, indent=2, ensure_ascii=False)

        # Optionally export full similarity matrix (large)
        if similarities:
            with open(os.path.join(output_dir, 'city_similarities.json'), 'w', encoding='utf-8') as f:
                json.dump(similarities, f, indent=2, ensure_ascii=False)

        self._mirror_outputs(output_dir, top_similarities is not None)

    def _mirror_outputs(self, output_dir, has_similarity_top):
        """Copy freshly generated JSON files into the frontend public folder."""
        public_root = Path('frontend') / 'public' / 'data' / 'processed'
        try:
            public_root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning('Unable to prepare frontend data folder: %s', exc)
            return

        output_path = Path(output_dir)
        filenames = ['cities.json', 'street_index.json', 'rarity_weights.json']
        if has_similarity_top:
            filenames.append('similarity_top.json')
        if self.city_name_graph:
            filenames.append('city_name_graph.json')

        for filename in filenames:
            source = output_path / filename
            if not source.exists():
                continue
            target = public_root / filename
            try:
                shutil.copy2(source, target)
            except OSError as exc:
                logger.warning('Failed to copy %s to public folder: %s', filename, exc)


def main():
    """Main processing function."""
    logger.info("Starting City Street Names Processing Pipeline")

    # Initialize pipeline
    pipeline = StreetProcessingPipeline()

    # Load data
    csv_path = "data/raw/norm.csv"
    pipeline.load_data(csv_path)

    # Compute rarity weights
    pipeline.compute_rarity_weights()

    # Build city honor graph before similarity calculations
    pipeline.build_city_name_honor_graph()

    # Calculate similarities
    similarities, base_pairs = pipeline.calculate_city_similarities()

    # Export results
    output_dir = "data/processed"

    # Compute top similarities per city
    from collections import defaultdict

    threshold = 0.00001
    top_similarities = defaultdict(list)

    def _append_similarity(source, target, pair):
        key = str(source)
        top_similarities[key].append({
            'city': str(target),
            'cityName': pipeline.city_names.get(target, ''),
            'weightedJaccard': round(pair['weighted_jaccard'], 4),
            'jaccard': round(pair['jaccard'], 4),
            'intersectionSize': pair['intersection_size'],
            'unionSize': pair['union_size'],
            'topSharedStreets': pair['top_shared_streets'][:5]
        })

    for pair_data in base_pairs:
        city_a = pair_data['city_a']
        city_b = pair_data['city_b']
        weighted_jaccard = pair_data['weighted_jaccard']
        jaccard_value = pair_data['jaccard']
        if weighted_jaccard <= threshold and jaccard_value <= threshold:
            continue
        _append_similarity(city_a, city_b, pair_data)
        _append_similarity(city_b, city_a, pair_data)

    similarity_top = {}
    for city_code, sims in top_similarities.items():
        sims.sort(key=lambda item: item['weightedJaccard'], reverse=True)
        similarity_top[str(city_code)] = sims[:10]

    pipeline.detect_communities(similarity_top)
    pipeline.export_data(output_dir, similarities, similarity_top)

    logger.info("Processing complete!")

if __name__ == "__main__":
    main()
