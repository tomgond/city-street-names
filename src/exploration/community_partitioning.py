#!/usr/bin/env python3
"""
Community partitioning experiments for the city-street-names project.

This scratchpad script reuses the aggregation pipeline to construct the
city similarity graph and then explores different community detection
parameters in an effort to break up oversized clusters (notably the
group that currently contains most of the large cities).
"""

from __future__ import annotations

import argparse
import logging
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple, Set

import networkx as nx
import statistics

ROOT_DIR = Path(__file__).resolve().parents[2]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding='utf-8')

from src.aggregation.build_data import (
    DEFAULT_TOP_NEIGHBOR_COUNT,
    DEFAULT_TOP_NEIGHBOR_PERCENTILE,
    StreetProcessingPipeline,
)

logger = logging.getLogger(__name__)


def build_pipeline_and_similarity(
    csv_path: str,
    similarity_threshold: float,
    top_neighbor_count: int,
    top_neighbor_percentile: float,
) -> Tuple[StreetProcessingPipeline, List[dict], Dict[str, List[dict]], dict]:
    """
    Run the aggregation pipeline just far enough to reuse the existing similarity
    scores. Returns the populated pipeline, the filtered similarity_top mapping,
    and basic stats about the filtering stage.
    """
    pipeline = StreetProcessingPipeline()
    pipeline.load_data(csv_path)
    pipeline.compute_rarity_weights()
    pipeline.compute_city_uniqueness_metrics()
    pipeline.build_city_name_honor_graph()
    _, base_pairs = pipeline.calculate_city_similarities()

    similarity_top, stats = build_similarity_top(
        pipeline,
        base_pairs,
        similarity_threshold=similarity_threshold,
        top_neighbor_count=top_neighbor_count,
        top_neighbor_percentile=top_neighbor_percentile,
    )
    return pipeline, base_pairs, similarity_top, stats


def build_similarity_top(
    pipeline: StreetProcessingPipeline,
    base_pairs: Sequence[dict],
    similarity_threshold: float,
    top_neighbor_count: int,
    top_neighbor_percentile: float,
) -> Tuple[Dict[str, List[dict]], dict]:
    """
    Recreate the similarity_top structure from build_data.py so we can tweak
    thresholds without touching the main pipeline.
    """
    top_similarities: Dict[str, List[dict]] = defaultdict(list)

    def _append(source: int, target: int, payload: dict) -> None:
        top_similarities[str(source)].append(
            {
                'city': str(target),
                'cityName': pipeline.city_names.get(target, ''),
                'weightedJaccard': payload['weighted_jaccard'],
                'jaccard': payload['jaccard'],
                'intersectionSize': payload['intersection_size'],
                'unionSize': payload['union_size'],
                'topSharedStreets': payload['top_shared_streets'][:5],
            }
        )

    for pair in base_pairs:
        if (
            pair['weighted_jaccard'] <= similarity_threshold
            and pair['jaccard'] <= similarity_threshold
        ):
            continue
        city_a = pair['city_a']
        city_b = pair['city_b']
        _append(city_a, city_b, pair)
        _append(city_b, city_a, pair)

    raw_edges = sum(len(entries) for entries in top_similarities.values())

    percentile_fraction = max(0.0, min(top_neighbor_percentile / 100.0, 1.0))
    similarity_top: Dict[str, List[dict]] = {}
    retained_edges = 0
    percentile_thresholds: List[float] = []

    for city_code, neighbors in top_similarities.items():
        if not neighbors:
            continue
        neighbors.sort(key=lambda entry: entry['weightedJaccard'], reverse=True)

        keep_count = len(neighbors)
        if percentile_fraction > 0.0:
            percentile_limit = max(1, math.ceil(len(neighbors) * percentile_fraction))
            keep_count = min(keep_count, percentile_limit)
        if top_neighbor_count > 0:
            keep_count = min(keep_count, top_neighbor_count)

        trimmed = neighbors[:keep_count]
        if trimmed:
            percentile_thresholds.append(trimmed[-1]['weightedJaccard'])
        similarity_top[city_code] = trimmed
        retained_edges += len(trimmed)

    stats = {
        'raw_edges': raw_edges,
        'retained_edges': retained_edges,
        'effective_threshold': min(percentile_thresholds) if percentile_thresholds else 0.0,
        'percentile_fraction': percentile_fraction,
    }
    return similarity_top, stats


def build_graph(
    city_names: Dict[int, str],
    similarity_top: Dict[str, List[dict]],
    city_street_sets: Dict[int, set],
    rarity_weights: Dict[str, float],
    city_rarity_sums: Dict[int, float],
    city_sizes: Dict[int, int],
    uniqueness_metrics: Dict[int, dict],
    focus_cities: Set[int],
    street_df: Dict[str, int],
    *,
    weight_mode: str,
    rarity_power: float,
    weight_exponent: float,
    uniqueness_gamma: float,
    size_gamma: float,
    size_reference: float,
    min_shared: int,
    metric_key: str,
    min_weight: float,
    max_rarity: float,
    focus_penalty: float,
    idf_power: float,
) -> nx.Graph:
    """
    Create an undirected NetworkX graph from the similarity_top payload, while allowing custom edge weights.
    """
    graph = nx.Graph()
    for city_code in city_names:
        graph.add_node(str(city_code))

    valid_metrics = {'weightedJaccard', 'jaccard'}
    default_metric = metric_key if metric_key in valid_metrics else 'weightedJaccard'
    epsilon = 1e-6

    def compute_similarity(city_a: int, city_b: int, fallback_entry: dict) -> float:
        streets_a = city_street_sets.get(city_a)
        streets_b = city_street_sets.get(city_b)
        if not streets_a or not streets_b:
            return 0.0

        intersection_keys = streets_a & streets_b
        if min_shared and len(intersection_keys) < min_shared:
            return 0.0
        union_keys = streets_a | streets_b

        if weight_mode == 'jaccard':
            union_size = len(union_keys)
            return len(intersection_keys) / union_size if union_size else 0.0

        if weight_mode == 'weighted_jaccard':
            union_weight = sum(rarity_weights.get(key, 0.0) for key in union_keys)
            if union_weight <= 0.0:
                return 0.0
            intersection_weight = sum(rarity_weights.get(key, 0.0) for key in intersection_keys)
            return intersection_weight / union_weight

        if weight_mode == 'rarity_power':
            norm_factor = max(max_rarity, epsilon)

            def weight_sum(keys: Iterable[str]) -> float:
                return sum(
                    (max(rarity_weights.get(key, 0.0), 0.0) / norm_factor) ** rarity_power
                    for key in keys
                )

            union_weight = weight_sum(union_keys)
            if union_weight <= 0.0:
                return 0.0
            intersection_weight = weight_sum(intersection_keys)
            return intersection_weight / union_weight

        if weight_mode == 'rarity_cosine':
            norm_factor = max(max_rarity, epsilon)
            weighted_overlap = sum(
                (rarity_weights.get(key, 0.0) / norm_factor) ** rarity_power for key in intersection_keys
            )
            norm_a = sum(
                (rarity_weights.get(key, 0.0) / norm_factor) ** rarity_power for key in streets_a
            )
            norm_b = sum(
                (rarity_weights.get(key, 0.0) / norm_factor) ** rarity_power for key in streets_b
            )
            denom = (norm_a ** 0.5) * (norm_b ** 0.5)
            return weighted_overlap / denom if denom > 0 else 0.0

        if weight_mode == 'rarity_ratio':
            intersection_weight = sum(rarity_weights.get(key, 0.0) for key in intersection_keys)
            total_a = city_rarity_sums.get(city_a, 0.0)
            total_b = city_rarity_sums.get(city_b, 0.0)
            denom = max(total_a, total_b, epsilon)
            return intersection_weight / denom if denom > 0 else 0.0

        if weight_mode == 'inverse_df':
            if not intersection_keys:
                return 0.0
            numerator = 0.0
            for key in intersection_keys:
                df = max(street_df.get(key, 0), 1)
                numerator += (1.0 / df) ** idf_power
            denom = max(min(len(streets_a), len(streets_b)), 1)
            return numerator / denom

        return float(fallback_entry.get(default_metric) or 0.0)

    edge_weights: Dict[Tuple[str, str], float] = {}
    for source, neighbors in similarity_top.items():
        if not neighbors:
            continue
        source_id = int(source)
        for entry in neighbors:
            target_raw = entry.get('city')
            if target_raw is None:
                continue
            target_id = int(target_raw)
            if target_id == source_id:
                continue

            base_weight = compute_similarity(source_id, target_id, entry)
            if base_weight <= 0.0:
                continue

            if uniqueness_gamma > 0.0:
                metrics_a = uniqueness_metrics.get(source_id, {})
                metrics_b = uniqueness_metrics.get(target_id, {})
                share_a = float(metrics_a.get('unique_street_share') or 0.0)
                share_b = float(metrics_b.get('unique_street_share') or 0.0)
                uniqueness_factor = ((share_a + share_b) / 2.0 + epsilon) ** uniqueness_gamma
                base_weight *= uniqueness_factor

            if size_gamma > 0.0:
                size_a = city_sizes.get(source_id, 0)
                size_b = city_sizes.get(target_id, 0)
                effective_max = max(size_a, size_b, epsilon)
                denom = max(size_reference, effective_max)
                size_factor = (size_reference / denom) ** size_gamma if denom > 0 else 0.0
                base_weight *= size_factor

            adjusted_weight = (
                max(base_weight, 0.0) ** weight_exponent if weight_exponent != 1.0 else max(base_weight, 0.0)
            )
            if adjusted_weight <= min_weight:
                continue

            if focus_penalty < 1.0 and source_id in focus_cities and target_id in focus_cities:
                adjusted_weight *= focus_penalty
                if adjusted_weight <= min_weight:
                    continue

            key = tuple(sorted((str(source_id), str(target_id))))
            if adjusted_weight > edge_weights.get(key, 0.0):
                edge_weights[key] = adjusted_weight

    for (node_a, node_b), weight in edge_weights.items():
        graph.add_edge(node_a, node_b, weight=weight)
    return graph


def sort_communities(communities: Iterable[Iterable[str]]) -> List[List[int]]:
    """
    Normalize community membership into sorted integer lists ordered by size.
    """
    normalized = []
    for community in communities:
        member_ids = []
        for member in community:
            try:
                member_ids.append(int(member))
            except (TypeError, ValueError):
                continue
        if member_ids:
            normalized.append(sorted(member_ids))
    normalized.sort(key=len, reverse=True)
    return normalized


def summarize_partition(
    communities: List[List[int]],
    city_names: Dict[int, str],
    top_city_codes: Sequence[int],
    sample_limit: int,
    community_limit: int,
) -> Dict[str, object]:
    """
    Build a compact summary that highlights the largest communities, their sizes,
    and how many of the largest cities they contain.
    """
    if not communities:
        return {
            'community_count': 0,
            'largest_sizes': [],
            'top_city_distribution': {},
            'top_communities': [],
        }

    size_counter = Counter(len(group) for group in communities)
    top_distribution = Counter()
    top_city_set = set(top_city_codes)

    summaries = []
    for idx, members in enumerate(communities[:community_limit]):
        names = [city_names.get(code, str(code)) for code in members]
        focus_hits = [code for code in members if code in top_city_set]
        focus_names = [city_names.get(code, str(code)) for code in focus_hits]
        for code in focus_hits:
            top_distribution[code] += 1
        summaries.append(
            {
                'rank': idx + 1,
                'size': len(members),
                'focus_hits': len(focus_hits),
                'focus_names': focus_names,
                'sample_members': names[:sample_limit],
            }
        )

    largest_sizes = [len(group) for group in communities[:community_limit]]
    return {
        'community_count': len(communities),
        'size_histogram': dict(size_counter),
        'largest_sizes': largest_sizes,
        'top_city_distribution': {
            code: top_distribution.get(code, 0) for code in top_city_codes
        },
        'top_communities': summaries,
    }


def run_louvain(graph: nx.Graph, resolution: float, seed: int) -> List[List[int]]:
    if graph.number_of_nodes() == 0:
        return []
    if graph.number_of_edges() == 0:
        return [[int(node)] for node in sorted(graph.nodes)]
    communities = nx.algorithms.community.louvain_communities(
        graph,
        weight='weight',
        resolution=resolution,
        seed=seed,
    )
    return sort_communities(communities)


def run_greedy(graph: nx.Graph) -> List[List[int]]:
    if graph.number_of_nodes() == 0:
        return []
    if graph.number_of_edges() == 0:
        return [[int(node)] for node in sorted(graph.nodes)]
    communities = nx.algorithms.community.greedy_modularity_communities(
        graph,
        weight='weight',
    )
    return sort_communities(communities)


def run_label_propagation(graph: nx.Graph, seed: int) -> List[List[int]]:
    if graph.number_of_nodes() == 0:
        return []
    rng = nx.utils.create_random_state(seed)
    communities = nx.algorithms.community.asyn_lpa_communities(
        graph,
        weight='weight',
        seed=rng,
    )
    return sort_communities(communities)


def largest_cities_by_streets(pipeline: StreetProcessingPipeline, limit: int) -> List[int]:
    ranking = sorted(
        ((code, len(streets)) for code, streets in pipeline.cities_data.items()),
        key=lambda item: item[1],
        reverse=True,
    )
    return [code for code, _ in ranking[:limit]]


def format_focus_report(top_city_codes: Sequence[int], city_names: Dict[int, str], distribution: Dict[int, int]) -> str:
    parts = []
    for code in top_city_codes:
        label = city_names.get(code, str(code))
        parts.append(f"{label} (#{code} → {distribution.get(code, 0)})")
    return ", ".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Experiment with community partitioning to break large city clusters."
    )
    parser.add_argument(
        '--csv',
        default='data/raw/norm.csv',
        help='Path to the normalized CSV used by the aggregation pipeline.',
    )
    parser.add_argument(
        '--similarity-threshold',
        type=float,
        default=1e-5,
        help='Minimum similarity value (applied to both weighted and plain Jaccard) before an edge is considered.',
    )
    parser.add_argument(
        '--top-neighbors',
        type=int,
        default=DEFAULT_TOP_NEIGHBOR_COUNT,
        help='Maximum number of neighbors retained per city when building the similarity graph.',
    )
    parser.add_argument(
        '--top-percentile',
        type=float,
        default=DEFAULT_TOP_NEIGHBOR_PERCENTILE,
        help='Percentile cap for retained neighbors per city.',
    )
    parser.add_argument(
        '--metric',
        choices=['weightedJaccard', 'jaccard'],
        default='weightedJaccard',
        help='Legacy metric used to populate the similarity_top structure (prior to custom re-weighting).',
    )
    parser.add_argument(
        '--min-weight',
        type=float,
        nargs='+',
        default=[0.0, 0.01, 0.02, 0.03],
        help='Edge weight cutoffs to test when building the experiment graph.',
    )
    parser.add_argument(
        '--resolution',
        type=float,
        nargs='+',
        default=[1.0, 1.3, 1.6, 2.0],
        help='Modularity resolution parameters to use with Louvain.',
    )
    parser.add_argument(
        '--label-propagation',
        action='store_true',
        help='Also run asynchronous label propagation for comparison.',
    )
    parser.add_argument(
        '--greedy',
        action='store_true',
        help='Also run greedy modularity (Clauset-Newman-Moore) for comparison.',
    )
    parser.add_argument(
        '--focus-top',
        type=int,
        default=12,
        help='How many of the largest cities (by normalized street count) to track when measuring breakup.',
    )
    parser.add_argument(
        '--community-limit',
        type=int,
        default=5,
        help='How many of the largest communities to display per experiment.',
    )
    parser.add_argument(
        '--sample-limit',
        type=int,
        default=8,
        help='How many city names to list for each community sample.',
    )
    parser.add_argument(
        '--seed',
        type=int,
        default=42,
        help='Random seed for algorithms that support reproducibility.',
    )
    parser.add_argument(
        '--show-focus',
        action='store_true',
        help='Print the community assignment for each tracked focus city.',
    )
    parser.add_argument(
        '--log-level',
        default='INFO',
        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
        help='Logging verbosity.',
    )
    parser.add_argument(
        '--focus-penalty',
        type=float,
        default=1.0,
        help='Multiply edge weights connecting focus cities by this factor (<1.0 to discourage a single mega-community).',
    )
    parser.add_argument(
        '--weight-mode',
        choices=[
            'weighted_jaccard',
            'jaccard',
            'rarity_power',
            'rarity_cosine',
            'rarity_ratio',
            'inverse_df',
        ],
        default='weighted_jaccard',
        help='How to derive edge weights before thresholding (applied symmetrically).',
    )
    parser.add_argument(
        '--rarity-power',
        type=float,
        default=1.75,
        help='Exponent used when weight-mode=rarity_power to accent rare overlaps (values >1 penalize common streets).',
    )
    parser.add_argument(
        '--weight-exponent',
        type=float,
        default=1.0,
        help='Apply an additional exponent to the computed similarity weight to sharpen ( >1 ) or smooth ( <1 ) distinctions.',
    )
    parser.add_argument(
        '--uniqueness-gamma',
        type=float,
        default=0.0,
        help='If >0, scale edge weights by ((share_a + share_b)/2 + 1e-6) ** gamma to penalize cities with few unique streets.',
    )
    parser.add_argument(
        '--size-gamma',
        type=float,
        default=0.0,
        help='If >0, multiply edge weights by (size_ref / max(size_ref, max(|A|,|B|))) ** gamma to penalize extremely large cities.',
    )
    parser.add_argument(
        '--idf-power',
        type=float,
        default=1.0,
        help='Exponent applied to inverse document frequency when weight-mode=inverse_df.',
    )
    parser.add_argument(
        '--min-shared',
        type=int,
        default=0,
        help='Drop edges where the intersection size is below this value after re-weighting.',
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format='%(asctime)s - %(levelname)s - %(message)s',
    )

    logger.info("Loading pipeline data from %s", args.csv)
    pipeline, _base_pairs, similarity_top, similarity_stats = build_pipeline_and_similarity(
        csv_path=args.csv,
        similarity_threshold=args.similarity_threshold,
        top_neighbor_count=args.top_neighbors,
        top_neighbor_percentile=args.top_percentile,
    )
    logger.info(
        "Similarity graph baseline: %d raw edges → %d retained (min per-city weight ≥ %.4f)",
        similarity_stats['raw_edges'],
        similarity_stats['retained_edges'],
        similarity_stats['effective_threshold'],
    )

    focus_city_codes = largest_cities_by_streets(pipeline, args.focus_top)
    focus_city_set = set(focus_city_codes)
    focus_labels = [pipeline.city_names.get(code, str(code)) for code in focus_city_codes]
    logger.info("Tracking %d largest cities: %s", args.focus_top, ", ".join(focus_labels))

    experiments: List[Tuple[str, float, float, List[List[int]]]] = []
    city_street_sets = {
        int(code): set(streets.keys()) for code, streets in pipeline.cities_data.items()
    }
    city_rarity_sums = {
        city_code: sum(pipeline.rarity_weights.get(street, 0.0) for street in streets)
        for city_code, streets in city_street_sets.items()
    }
    city_sizes = {city_code: len(streets) for city_code, streets in city_street_sets.items()}
    uniqueness_metrics = pipeline.city_uniqueness
    max_rarity_weight = max(pipeline.rarity_weights.values()) if pipeline.rarity_weights else 1.0
    size_reference = statistics.median(city_sizes.values()) if city_sizes else 1.0
    street_df = {key: len(cities) for key, cities in pipeline.street_to_cities.items()}
    for min_weight in args.min_weight:
        graph = build_graph(
            pipeline.city_names,
            similarity_top,
            city_street_sets,
            pipeline.rarity_weights,
            city_rarity_sums,
            city_sizes,
            uniqueness_metrics,
            focus_cities=focus_city_set,
            street_df=street_df,
            weight_mode=args.weight_mode,
            rarity_power=args.rarity_power,
            weight_exponent=args.weight_exponent,
            uniqueness_gamma=args.uniqueness_gamma,
            size_gamma=args.size_gamma,
            size_reference=size_reference,
            min_shared=args.min_shared,
            metric_key=args.metric,
            min_weight=min_weight,
            max_rarity=max_rarity_weight,
            focus_penalty=args.focus_penalty,
            idf_power=args.idf_power,
        )
        logger.info(
            "Graph built with min_weight %.3f → %d nodes, %d edges",
            min_weight,
            graph.number_of_nodes(),
            graph.number_of_edges(),
        )

        for resolution in args.resolution:
            communities = run_louvain(graph, resolution=resolution, seed=args.seed)
            experiments.append((f"louvain(res={resolution:.2f}, min_w={min_weight:.3f})", min_weight, resolution, communities))

        if args.greedy:
            communities = run_greedy(graph)
            experiments.append((f"greedy(min_w={min_weight:.3f})", min_weight, math.nan, communities))

        if args.label_propagation:
            communities = run_label_propagation(graph, seed=args.seed)
            experiments.append((f"label_propagation(min_w={min_weight:.3f})", min_weight, math.nan, communities))

    for label, min_weight, resolution, communities in experiments:
        summary = summarize_partition(
            communities,
            pipeline.city_names,
            focus_city_codes,
            sample_limit=args.sample_limit,
            community_limit=args.community_limit,
        )
        logger.info(
            "[%s] → %d communities, largest sizes: %s",
            label,
            summary['community_count'],
            summary['largest_sizes'],
        )
        focus_report = format_focus_report(
            focus_city_codes,
            pipeline.city_names,
            summary['top_city_distribution'],
        )
        print("=" * 80)
        print(f"Experiment: {label}")
        print(f"Communities: {summary['community_count']}")
        print(f"Largest community sizes: {summary['largest_sizes']}")
        print(f"Focus city distribution: {focus_report}")
        print("Top communities:")
        for entry in summary['top_communities']:
            print(
                f"  #{entry['rank']} size={entry['size']} focus_hits={entry['focus_hits']} "
                f"focus={entry['focus_names']}"
            )
            print(f"     sample={entry['sample_members']}")
        print()

        if args.show_focus:
            focus_membership: Dict[int, Tuple[int, List[int]]] = {}
            for idx, members in enumerate(communities):
                member_set = set(members)
                for code in focus_city_codes:
                    if code in member_set and code not in focus_membership:
                        focus_membership[code] = (idx, members)
                if len(focus_membership) == len(focus_city_codes):
                    break

            for code in focus_city_codes:
                label = pipeline.city_names.get(code, str(code))
                info = focus_membership.get(code)
                if not info:
                    print(f"    {label} (# {code}) → isolated / no community assignment")
                    continue
                comm_idx, members = info
                sample_names = [
                    pipeline.city_names.get(member, str(member)) for member in members[: max(1, args.sample_limit)]
                ]
                print(
                    f"    {label} (# {code}) → community #{comm_idx + 1} "
                    f"(size {len(members)}) sample={sample_names}"
                )
            print()


if __name__ == '__main__':
    main()
