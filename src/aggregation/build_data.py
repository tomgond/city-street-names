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
import statistics
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import networkx as nx

# Allow running the script directly without requiring PYTHONPATH tweaks
ROOT_DIR = Path(__file__).resolve().parents[2]
SRC_DIR = ROOT_DIR / 'src'
for candidate in (ROOT_DIR, SRC_DIR):
    candidate_str = str(candidate)
    if candidate_str not in sys.path:
        sys.path.insert(0, candidate_str)

from src.normalization.norm_data import normalize_name

# Minimum streets required for a city to appear in the honor graph
MIN_STREETS_FOR_HONOR_GRAPH = 30

# Maximum number of similar neighbors retained per city in similarity outputs
DEFAULT_TOP_NEIGHBOR_COUNT = int(os.environ.get('CITY_SIMILARITY_TOP_N', '20'))
DEFAULT_TOP_NEIGHBOR_PERCENTILE = float(os.environ.get('CITY_SIMILARITY_TOP_PERCENTILE', '30'))

# Optional community detection tuning via environment variables
# Default to the TF-IDF weighted Jaccard edge weights that were validated in
# the exploration tooling. Alternate modes (like ``inverse_df``) remain
# opt-in via the ``COMMUNITY_WEIGHT_MODE`` environment variable.
DEFAULT_COMMUNITY_WEIGHT_MODE = 'weighted_jaccard'
_community_weight_mode_raw = os.environ.get('COMMUNITY_WEIGHT_MODE', '').strip()
COMMUNITY_WEIGHT_MODE = (
    _community_weight_mode_raw.lower()
    if _community_weight_mode_raw
    else DEFAULT_COMMUNITY_WEIGHT_MODE
)

_community_idf_power_raw = os.environ.get('COMMUNITY_IDF_POWER')
if _community_idf_power_raw is not None:
    try:
        COMMUNITY_IDF_POWER = float(_community_idf_power_raw)
    except ValueError:
        COMMUNITY_IDF_POWER = 1.0
else:
    COMMUNITY_IDF_POWER = 1.1 if COMMUNITY_WEIGHT_MODE == 'inverse_df' else 1.0

_community_min_shared_raw = os.environ.get('COMMUNITY_MIN_SHARED')
if _community_min_shared_raw is not None:
    try:
        COMMUNITY_MIN_SHARED = int(float(_community_min_shared_raw))
    except ValueError:
        COMMUNITY_MIN_SHARED = 0
else:
    COMMUNITY_MIN_SHARED = 0

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class StreetProcessingPipeline:
    def __init__(self):
        self.cities_data = defaultdict(dict)
        self.city_street_counts = defaultdict(Counter)
        self.city_total_street_counts = defaultdict(int)
        self.city_street_meta = defaultdict(dict)
        self.street_to_cities = defaultdict(set)
        self.norm_keys = {}
        self.norm_display_counts = defaultdict(Counter)
        self.rarity_weights = {}
        self.city_names = {}
        self.city_communities = {}
        self.city_name_graph = {}
        self.city_uniqueness = {}
        self.city_uniqueness_ranking = []

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
                self.city_street_counts[city_code][norm_key] += 1
                self.city_total_street_counts[city_code] += 1

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
            if df <= 0:
                continue
            self.rarity_weights[norm_key] = 1.0 / math.log(1 + df)

        if self.rarity_weights:
            max_weight = max(self.rarity_weights.values())
            if max_weight > 0:
                scale = 100.0 / max_weight
                for norm_key, weight in list(self.rarity_weights.items()):
                    self.rarity_weights[norm_key] = weight * scale

        compute_time = time.time() - start_time
        logger.info("Computed rarity weights in %.2fs", compute_time)
        return self

    def compute_city_uniqueness_metrics(self):
        """Summarize per-city uniqueness and rarity statistics."""
        logger.info("Computing per-city uniqueness metrics")
        start_time = time.time()

        unique_counts = defaultdict(int)
        for norm_key, cities in self.street_to_cities.items():
            if len(cities) != 1:
                continue
            city_code = next(iter(cities))
            unique_counts[city_code] += 1

        metrics = {}
        ranking_entries = []
        for city_code, streets in self.cities_data.items():
            street_keys = list(streets.keys())
            total_streets = len(street_keys)
            if total_streets:
                weights = [self.rarity_weights.get(key, 0.0) for key in street_keys]
                mean_weight = sum(weights) / total_streets if weights else 0.0
                median_weight = statistics.median(weights) if weights else 0.0
            else:
                mean_weight = 0.0
                median_weight = 0.0

            unique_count = unique_counts.get(city_code, 0)
            share = (unique_count / total_streets) if total_streets else 0.0

            metrics[city_code] = {
                'unique_street_count': unique_count,
                'unique_street_share': share,
                'mean_rarity_weight': mean_weight,
                'median_rarity_weight': median_weight,
            }

            ranking_entries.append({
                'id': str(city_code),
                'name': self.city_names.get(city_code, ''),
                'streetCount': total_streets,
                'uniqueStreetCount': unique_count,
                'uniqueStreetShare': share,
                'meanRarityWeight': mean_weight,
                'medianRarityWeight': median_weight,
            })

        ranking_entries.sort(
            key=lambda item: (
                -(item['uniqueStreetShare'] or 0.0),
                -(item['uniqueStreetCount'] or 0),
                -(item['meanRarityWeight'] or 0.0),
                item['name'],
            )
        )

        self.city_uniqueness = metrics
        self.city_uniqueness_ranking = ranking_entries

        elapsed = time.time() - start_time
        logger.info("Computed uniqueness metrics for %d cities in %.2fs", len(metrics), elapsed)
        return self

    def calculate_jaccard_similarity(self, city_a_streets, city_b_streets):
        """Calculate Jaccard similarity between two cities' street sets."""
        intersection = city_a_streets & city_b_streets
        union = city_a_streets | city_b_streets

        if not union:
            return 0.0

        return len(intersection) / len(union)

    def calculate_weighted_jaccard_similarity(self, city_a_code, city_b_code):
        """Calculate TF-IDF weighted Jaccard similarity between two cities."""
        counts_a = self.city_street_counts.get(city_a_code)
        counts_b = self.city_street_counts.get(city_b_code)
        if not counts_a or not counts_b:
            return 0.0

        total_a = self.city_total_street_counts.get(city_a_code, 0)
        total_b = self.city_total_street_counts.get(city_b_code, 0)
        if total_a <= 0 or total_b <= 0:
            return 0.0

        union_keys = set(counts_a.keys()) | set(counts_b.keys())
        if not union_keys:
            return 0.0

        numerator = 0.0
        denominator = 0.0

        for norm_key in union_keys:
            rarity_weight = self.rarity_weights.get(norm_key, 0.0)
            if rarity_weight <= 0.0:
                # Keys without rarity weight do not affect the score.
                continue

            tf_a = counts_a.get(norm_key, 0) / total_a
            tf_b = counts_b.get(norm_key, 0) / total_b

            weighted_a = tf_a * rarity_weight
            weighted_b = tf_b * rarity_weight

            numerator += min(weighted_a, weighted_b)
            denominator += max(weighted_a, weighted_b)

        return numerator / denominator if denominator > 0 else 0.0

    def get_top_shared_streets(
        self,
        city_a_streets,
        city_b_streets,
        top_n=DEFAULT_TOP_NEIGHBOR_COUNT,
    ):
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

    def detect_communities(
        self,
        similarity_top,
        metric='weightedJaccard',
        min_weight=0.0,
        *,
        weight_mode='',
        idf_power=1.0,
        min_shared=0,
    ):
        """Detect communities using NetworkX community detection algorithms."""
        logger.info(
            "Detecting city communities using NetworkX (metric=%s, weight_mode=%s, idf_power=%s, min_shared=%s)",
            metric,
            weight_mode or COMMUNITY_WEIGHT_MODE or 'weightedJaccard',
            idf_power,
            min_shared,
        )
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

        weight_mode_normalized = (weight_mode or '').strip().lower()
        use_inverse_df = weight_mode_normalized == 'inverse_df'
        min_shared_threshold = max(0, int(min_shared or 0))
        try:
            idf_power_value = float(idf_power)
        except (TypeError, ValueError):
            idf_power_value = 1.0

        city_street_sets = {}
        if use_inverse_df:
            city_street_sets = {
                str(city_code): set(streets.keys())
                for city_code, streets in self.cities_data.items()
            }
            street_document_frequency = {
                norm_key: max(len(cities), 1)
                for norm_key, cities in self.street_to_cities.items()
            }

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

                weight = 0.0
                if use_inverse_df:
                    streets_a = city_street_sets.get(source_id)
                    streets_b = city_street_sets.get(target_id)
                    if not streets_a or not streets_b:
                        continue
                    intersection_keys = streets_a & streets_b
                    if min_shared_threshold and len(intersection_keys) < min_shared_threshold:
                        continue
                    if not intersection_keys:
                        continue
                    numerator = 0.0
                    for norm_key in intersection_keys:
                        df = street_document_frequency.get(norm_key, 1)
                        numerator += (1.0 / df) ** idf_power_value
                    denominator = max(min(len(streets_a), len(streets_b)), 1)
                    weight = numerator / denominator if denominator else 0.0
                else:
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

    def export_similarity_graph_for_gephi(self, similarity_top, output_dir, metric='weightedJaccard'):
        """Export the filtered similarity graph to a GEXF file for Gephi."""
        metric_key = metric if metric in {'weightedJaccard', 'jaccard'} else 'weightedJaccard'
        graph = nx.Graph()
        output_path = Path(output_dir)

        for city_code, name in self.city_names.items():
            node_id = str(city_code)
            node_attrs = {
                'label': name,
                'cityName': name,
                'cityCode': node_id,
                'streetCount': len(self.cities_data.get(city_code, {})),
            }
            community_id = self.city_communities.get(node_id)
            if community_id is None:
                community_id = self.city_communities.get(city_code)
            if community_id is not None:
                try:
                    node_attrs['community'] = int(community_id)
                except (TypeError, ValueError):
                    node_attrs['community'] = community_id
            graph.add_node(node_id, **node_attrs)

        edge_map = {}
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
                jaccard_value = float(entry.get('jaccard') or 0.0)
                edge_key = tuple(sorted((source_id, target_id)))
                current = edge_map.get(edge_key)
                if current is None or weight > current['weight']:
                    edge_map[edge_key] = {'weight': weight, 'jaccard': jaccard_value}

        for (node_a, node_b), attrs in edge_map.items():
            graph.add_edge(node_a, node_b, weight=attrs['weight'], jaccard=attrs['jaccard'])

        if graph.number_of_edges() == 0:
            logger.warning('No city similarity edges passed the threshold; skipping Gephi export')
            return self

        try:
            output_path.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning('Unable to prepare Gephi export path %s: %s', output_path, exc)
            return self

        gephi_path = output_path / 'city_similarity_graph.gexf'
        try:
            nx.write_gexf(graph, gephi_path)
            logger.info('Exported city similarity graph to %s', gephi_path)
        except Exception as exc:
            logger.warning('Failed to export Gephi graph: %s', exc)

        return self

    def build_city_name_honor_graph(self):
        """Build a directed graph of cities that name streets after other cities."""
        logger.info("Building city honor graph based on street names")
        start_time = time.time()

        def _normalize_code(raw_code):
            try:
                return int(raw_code)
            except (TypeError, ValueError):
                return raw_code

        street_counts = {}
        eligible_codes = set()
        eligible_lookup = set()

        def _register_lookup(value):
            eligible_lookup.add(value)
            eligible_lookup.add(str(value))

        for code, streets in self.cities_data.items():
            count = len(streets)
            street_counts[code] = count
            street_counts[str(code)] = count
            normalized_code = _normalize_code(code)
            street_counts[normalized_code] = count
            street_counts[str(normalized_code)] = count
            if count >= MIN_STREETS_FOR_HONOR_GRAPH:
                eligible_codes.add(str(code))
                _register_lookup(code)
                _register_lookup(normalized_code)

        if not eligible_codes:
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
            logger.warning(
                "No cities meet the minimum street threshold (%d)",
                MIN_STREETS_FOR_HONOR_GRAPH
            )
            return self

        city_key_to_codes = defaultdict(set)
        city_display_by_code = {}

        def _is_eligible(raw_code):
            if raw_code in eligible_lookup:
                return True
            normalized = _normalize_code(raw_code)
            return normalized in eligible_lookup or str(normalized) in eligible_lookup

        def _city_name_lookup(raw_code):
            try:
                numeric = int(raw_code)
            except (TypeError, ValueError):
                return self.city_names.get(raw_code, '')
            return self.city_names.get(numeric, self.city_names.get(raw_code, ''))

        for code, name in self.city_names.items():
            if not _is_eligible(code):
                continue
            normalized = normalize_name(name, drop_he=False)
            display_value = normalized["display"] or name
            normalized_code_value = _normalize_code(code)
            for variant in {code, str(code), normalized_code_value, str(normalized_code_value)}:
                city_display_by_code[variant] = display_value
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
            if not _is_eligible(source_code):
                continue
            normalized_source_code = _normalize_code(source_code)
            source_city_data = self.cities_data.get(source_code)
            if source_city_data is None:
                source_city_data = self.cities_data.get(normalized_source_code, {})
            for norm_key, meta in streets.items():
                target_codes = city_key_to_codes.get(norm_key)
                if not target_codes:
                    continue
                for target_code in target_codes:
                    if not _is_eligible(target_code):
                        continue
                    if target_code == source_code:
                        continue
                    edge_key = (str(source_code), str(target_code))
                    street_record = {
                        'normKey': norm_key,
                        'display': meta.get('display') or self.norm_keys.get(norm_key, norm_key),
                        'normDisplay': meta.get('norm_display') or source_city_data.get(norm_key, ''),
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
            street_count = street_counts.get(numeric_code, street_counts.get(code, 0))
            if street_count < MIN_STREETS_FOR_HONOR_GRAPH:
                continue
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
        allowed_ids = {str(node['id']) for node in nodes_output}

        links_output = []
        for (src, dst), data in sorted(edges.items(), key=lambda item: (item[0][0], item[0][1])):
            if src not in allowed_ids or dst not in allowed_ids:
                continue
            links_output.append({
                'source': src,
                'target': dst,
                'streetCount': len(data['streets']),
                'streets': data['streets']
            })

        gephi_graph = nx.DiGraph()
        for node in nodes_output:
            node_id = str(node['id'])
            if node_id not in allowed_ids:
                continue
            gephi_graph.add_node(
                node_id,
                label=node['displayName'],
                cityName=node['name'],
                streetCount=node['streetCount'],
                honorsOut=node['honorsOut'],
                honorsIn=node['honorsIn'],
                honorStreetOut=node['honorStreetOut'],
                honorStreetIn=node['honorStreetIn']
            )
        for link in links_output:
            street_names = [street['display'] for street in link['streets']]
            gephi_graph.add_edge(
                link['source'],
                link['target'],
                weight=link['streetCount'],
                streetCount=link['streetCount'],
                streetNames=' | '.join(street_names)
            )
        gephi_path = Path('data/processed/city_honor_graph.gexf')
        try:
            gephi_path.parent.mkdir(parents=True, exist_ok=True)
            nx.write_gexf(gephi_graph, gephi_path)
            logger.info('Saved honor graph for Gephi: %s', gephi_path)
        except Exception as exc:
            logger.warning('Failed to save honor graph for Gephi: %s', exc)

        self.city_name_graph = {
            'nodes': nodes_output,
            'links': links_output,
            'stats': {
                'cityCount': len(nodes_output),
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
                weighted_jaccard = self.calculate_weighted_jaccard_similarity(city_a, city_b)
                top_streets = self.get_top_shared_streets(
                    city_a_streets,
                    city_b_streets,
                    top_n=DEFAULT_TOP_NEIGHBOR_COUNT,
                )

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

            uniqueness = self.city_uniqueness.get(city_code)
            if uniqueness:
                city_entry['uniqueStreetCount'] = uniqueness['unique_street_count']
                city_entry['uniqueStreetShare'] = round(uniqueness['unique_street_share'], 6)
                city_entry['meanRarityWeight'] = round(uniqueness['mean_rarity_weight'], 6)
                city_entry['medianRarityWeight'] = round(uniqueness['median_rarity_weight'], 6)
            else:
                city_entry['uniqueStreetCount'] = 0
                city_entry['uniqueStreetShare'] = 0.0
                city_entry['meanRarityWeight'] = 0.0
                city_entry['medianRarityWeight'] = 0.0

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

        if self.city_uniqueness_ranking:
            uniqueness_output = []
            for rank, entry in enumerate(self.city_uniqueness_ranking, start=1):
                uniqueness_output.append({
                    **entry,
                    'rank': rank,
                    'uniqueStreetShare': round(entry['uniqueStreetShare'], 6),
                    'meanRarityWeight': round(entry['meanRarityWeight'], 6),
                    'medianRarityWeight': round(entry['medianRarityWeight'], 6),
                })

            with open(os.path.join(output_dir, 'city_uniqueness.json'), 'w', encoding='utf-8') as f:
                json.dump(uniqueness_output, f, indent=2, ensure_ascii=False)

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
        if self.city_uniqueness_ranking:
            filenames.append('city_uniqueness.json')

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

    # Summarize per-city uniqueness metrics
    pipeline.compute_city_uniqueness_metrics()

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

    raw_edge_count = sum(len(sims) for sims in top_similarities.values())
    percentile_fraction = max(0.0, min(DEFAULT_TOP_NEIGHBOR_PERCENTILE / 100.0, 1.0))

    similarity_top = {}
    retained_edge_count = 0
    percentile_thresholds = []
    for city_code, sims in top_similarities.items():
        # Prioritize neighbors by the TF-IDF weighted Jaccard score.
        sims.sort(key=lambda item: item['weightedJaccard'], reverse=True)

        keep_count = len(sims)
        if percentile_fraction > 0.0 and sims:
            percentile_limit = max(1, math.ceil(len(sims) * percentile_fraction))
            keep_count = min(keep_count, percentile_limit)
        if DEFAULT_TOP_NEIGHBOR_COUNT > 0:
            keep_count = min(keep_count, DEFAULT_TOP_NEIGHBOR_COUNT)

        filtered_entries = sims[:keep_count]
        if filtered_entries:
            percentile_thresholds.append(filtered_entries[-1].get('weightedJaccard', 0.0))

        similarity_top[str(city_code)] = filtered_entries
        retained_edge_count += len(filtered_entries)

    if percentile_fraction > 0.0 and percentile_thresholds:
        logger.info(
            "Retained %d of %d city similarity pairs using top %.1f%% threshold (per-city min >= %.4f)",
            retained_edge_count,
            raw_edge_count,
            percentile_fraction * 100,
            min(percentile_thresholds),
        )
    else:
        logger.info(
            "Retained %d city similarity pairs without percentile threshold",
            retained_edge_count,
        )

    pipeline.detect_communities(
        similarity_top,
        weight_mode=COMMUNITY_WEIGHT_MODE,
        idf_power=COMMUNITY_IDF_POWER,
        min_shared=COMMUNITY_MIN_SHARED,
    )
    pipeline.export_similarity_graph_for_gephi(similarity_top, output_dir)
    pipeline.export_data(output_dir, similarities, similarity_top)

    logger.info("Processing complete!")

if __name__ == "__main__":
    main()

