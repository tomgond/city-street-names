#!/usr/bin/env python2
"""
Processing Pipeline for City Street Names Analysis

This script loads normalized street data and builds similarity metrics between cities
based on shared street names.
"""

import csv
import json
import logging
from collections import defaultdict
from itertools import combinations
import time
import math
import os

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class StreetProcessingPipeline:
    def __init__(self):
        self.cities_data = defaultdict(dict)
        self.street_to_cities = defaultdict(set)
        self.norm_keys = {}
        self.rarity_weights = {}
        self.city_names = {}

    def load_data(self, csv_path):
        """Load street data from CSV file."""
        logger.info("Loading data from {}".format(csv_path))
        start_time = time.time()

        with open(csv_path, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                city_code = int(row['city_code'])
                city_name = row['city_name']
                norm_key = row['norm_key']
                norm_display = row['norm_display']

                # Store city name
                if city_code not in self.city_names:
                    self.city_names[city_code] = city_name

                # Store normalized key and display name
                if norm_key not in self.norm_keys:
                    self.norm_keys[norm_key] = norm_display

                # Add to per-city set
                self.cities_data[city_code][norm_key] = norm_display

                # Add to inverted index
                self.street_to_cities[norm_key].add(city_code)

        load_time = time.time() - start_time
        logger.info(".2f")
        return self

    def compute_rarity_weights(self):
        """Compute rarity weights for each normalized street key."""
        logger.info("Computing rarity weights")
        start_time = time.time()

        for norm_key, cities in self.street_to_cities.items():
            df = len(cities)
            self.rarity_weights[norm_key] = 1.0 / math.log(1 + df)

        compute_time = time.time() - start_time
        logger.info(".2f")
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

        union_a = city_a_streets | city_b_streets
        union_b = city_a_streets | city_b_streets

        if not (union_a | union_b):
            return 0.0

        # Weighted intersection
        intersection_weight = sum(self.rarity_weights[street] for street in intersection)

        # Weighted union
        union_weight = sum(self.rarity_weights[street] for street in (union_a | union_b))

        return intersection_weight / union_weight if union_weight > 0 else 0.0

    def get_top_shared_streets(self, city_a_streets, city_b_streets, top_n=10):
        """Get top shared streets by rarity weight."""
        intersection = city_a_streets & city_b_streets

        # Sort by rarity weight descending
        sorted_streets = sorted(
            intersection,
            key=lambda s: self.rarity_weights[s],
            reverse=True
        )

        return [
            {
                'norm_key': street,
                'display_name': self.norm_keys[street],
                'rarity_weight': self.rarity_weights[street]
            }
            for street in sorted_streets[:top_n]
        ]

    def calculate_city_similarities(self):
        """Calculate similarities between all city pairs."""
        logger.info("Calculating city similarities")
        start_time = time.time()

        city_codes = list(self.cities_data.keys())
        similarities = defaultdict(dict)

        total_pairs = len(city_codes) * (len(city_codes) - 1) // 2
        processed = 0

        for i, city_a in enumerate(city_codes):
            for j, city_b in enumerate(city_codes[i+1:], i+1):
                city_a_streets = set(self.cities_data[city_a].keys())
                city_b_streets = set(self.cities_data[city_b].keys())

                jaccard = self.calculate_jaccard_similarity(city_a_streets, city_b_streets)
                weighted_jaccard = self.calculate_weighted_jaccard_similarity(city_a_streets, city_b_streets)
                top_streets = self.get_top_shared_streets(city_a_streets, city_b_streets, top_n=10)

                similarities["{}_{}".format(city_a, city_b)] = {
                    'city_a': city_a,
                    'city_b': city_b,
                    'jaccard': round(jaccard, 4),
                    'weighted_jaccard': round(weighted_jaccard, 4),
                    'intersection_size': len(city_a_streets & city_b_streets),
                    'union_size': len(city_a_streets | city_b_streets),
                    'top_shared_streets': top_streets
                }

                processed += 1
                if processed % 10000 == 0:
                    logger.info("Processed {}/{} pairs".format(processed, total_pairs))

        calc_time = time.time() - start_time
        logger.info(".2f")

        return similarities

    def export_data(self, output_dir, similarities=None):
        """Export processed data to JSON files."""
        logger.info("Exporting data to {}".format(output_dir))

        # Export cities data
        cities_output = dict()
        for city_code, streets in self.cities_data.items():
            cities_output[city_code] = {
                'city_name': self.city_names.get(city_code, ''),
                'street_count': len(streets),
                'normalized_keys': list(streets.keys())
            }

        with open(os.path.join(output_dir, 'cities.json'), 'w') as f:
            json.dump(cities_output, f, indent=2, ensure_ascii=False)

        # Export street to cities index
        street_index_output = dict()
        for street, cities in self.street_to_cities.items():
            street_index_output[street] = list(cities)

        with open(os.path.join(output_dir, 'street_index.json'), 'w') as f:
            json.dump(street_index_output, f, indent=2, ensure_ascii=False)

        # Export rarity weights
        with open(os.path.join(output_dir, 'rarity_weights.json'), 'w') as f:
            json.dump(self.rarity_weights, f, indent=2, ensure_ascii=False)

        # Export city similarities (if provided)
        if similarities:
            with open(os.path.join(output_dir, 'city_similarities.json'), 'w') as f:
                json.dump(similarities, f, indent=2, ensure_ascii=False)

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

    # Calculate similarities
    similarities = pipeline.calculate_city_similarities()

    # Export results
    output_dir = "data/processed"
    pipeline.export_data(output_dir, similarities)

    logger.info("Processing complete!")

if __name__ == "__main__":
    main()
