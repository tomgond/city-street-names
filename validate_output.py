#!/usr/bin/env python2
# -*- coding: utf-8 -*-
import sys
reload(sys)
sys.setdefaultencoding('utf-8')
"""
Validation Script for City Street Names Processing Output

This script validates the output files from the processing pipeline
to ensure consistency and correctness.
"""

import json
import os
import sys

def validate_cities_json():
    """Validate cities.json structure and consistency."""
    print("Validating cities.json...")

    try:
        with open('data/processed/cities.json', 'r') as f:
            cities_data = json.load(f)
    except IOError:
        print("ERROR: cities.json not found")
        return False

    if not cities_data:
        print("ERROR: cities.json is empty")
        return False

    city_codes = set()
    total_streets = 0

    for city_code, data in cities_data.items():
        if not isinstance(city_code, (str, int)) and not (hasattr(city_code, 'encode') and hasattr(city_code, 'decode')):
            print("ERROR: City code {} has invalid type: {}".format(city_code, type(city_code)))
            return False

        if 'street_count' not in data:
            print("ERROR: City {} missing street_count".format(city_code))
            return False

        if 'normalized_keys' not in data:
            print("ERROR: City {} missing normalized_keys".format(city_code))
            return False

        street_count = data['street_count']
        normalized_keys = data['normalized_keys']

        if street_count != len(normalized_keys):
            print("ERROR: City {} street count mismatch: {} vs {}".format(city_code, street_count, len(normalized_keys)))
            return False

        if len(set(normalized_keys)) != len(normalized_keys):
            print("ERROR: City {} has duplicate normalized keys".format(city_code))
            return False

        city_codes.add(city_code)
        total_streets += street_count

    print("✓ cities.json: {} cities, {} total streets".format(len(city_codes), total_streets))
    return city_codes, total_streets

def validate_street_index_json(valid_city_codes):
    """Validate street_index.json structure and consistency."""
    print("Validating street_index.json...")

    try:
        with open('data/processed/street_index.json', 'r') as f:
            street_index = json.load(f)
    except IOError:
        print("ERROR: street_index.json not found")
        return False

    if not street_index:
        print("ERROR: street_index.json is empty")
        return False

    unique_streets = set()
    total_mappings = 0

    for street, cities in street_index.items():
        if not cities:
            print("ERROR: Street '{}' has no cities".format(street))
            return False

        for city in cities:
            if str(city) not in valid_city_codes and city not in valid_city_codes:
                print("ERROR: Street '{}' references invalid city {}".format(street, city))
                return False

        unique_streets.add(street)
        total_mappings += len(cities)

    print("✓ street_index.json: {} unique streets, {} city mappings".format(len(unique_streets), total_mappings))
    return unique_streets

def validate_rarity_weights_json(unique_streets):
    """Validate rarity_weights.json structure and consistency."""
    print("Validating rarity_weights.json...")

    try:
        with open('data/processed/rarity_weights.json', 'r') as f:
            rarity_weights = json.load(f)
    except IOError:
        print("ERROR: rarity_weights.json not found")
        return False

    if not rarity_weights:
        print("ERROR: rarity_weights.json is empty")
        return False

    weights_in_index = set(rarity_weights.keys())

    if weights_in_index != unique_streets:
        missing_in_weights = unique_streets - weights_in_index
        extra_in_weights = weights_in_index - unique_streets
        if missing_in_weights:
            print("ERROR: Streets missing in rarity_weights: {}".format(list(missing_in_weights)[:5]))
        if extra_in_weights:
            print("ERROR: Extra streets in rarity_weights: {}".format(list(extra_in_weights)[:5]))
        return False

    # Check weight values are reasonable
    for street, weight in rarity_weights.items():
        if not isinstance(weight, (int, float)) or weight <= 0:
            print("ERROR: Invalid weight for street '{}': {}".format(street, weight))
            return False
        if weight > 1.0:
            print("WARNING: Weight > 1.0 for street '{}': {}".format(street, weight))

    min_weight = min(rarity_weights.values())
    max_weight = max(rarity_weights.values())

    print("✓ rarity_weights.json: {} streets, weights range [{:.4f}, {:.4f}]".format(
        len(rarity_weights), min_weight, max_weight))
    return True

def validate_city_similarities_json(valid_city_codes):
    """Validate city_similarities.json structure and consistency."""
    print("Validating city_similarities.json...")

    try:
        with open('data/processed/city_similarities.json', 'r') as f:
            similarities = json.load(f)
    except IOError:
        print("ERROR: city_similarities.json not found")
        return False

    if not similarities:
        print("ERROR: city_similarities.json is empty")
        return False

    expected_pairs = len(valid_city_codes) * (len(valid_city_codes) - 1) // 2
    sim_pairs = len(similarities)

    if sim_pairs != expected_pairs:
        print("ERROR: Expected {} city pairs, got {}".format(expected_pairs, sim_pairs))
        return False

    # Check a few sample pairs for structure
    sample_count = min(3, sim_pairs)
    samples_checked = 0

    for pair_key, pair_data in similarities.items():
        try:
            city_a_str, city_b_str = pair_key.split('_')
            city_a = int(city_a_str)
            city_b = int(city_b_str)
        except (ValueError, AttributeError):
            print("ERROR: Invalid pair key format: {}".format(pair_key))
            return False

        if city_a not in valid_city_codes or city_b not in valid_city_codes:
            print("ERROR: Pair {} references invalid cities".format(pair_key))
            return False

        required_fields = ['city_a', 'city_b', 'jaccard', 'weighted_jaccard',
                          'intersection_size', 'union_size', 'top_shared_streets']

        for field in required_fields:
            if field not in pair_data:
                print("ERROR: Pair {} missing field {}".format(pair_key, field))
                return False

        similarity_metrics = ['jaccard', 'weighted_jaccard']
        for metric in similarity_metrics:
            value = pair_data[metric]
            if not isinstance(value, (int, float)) or not (0.0 <= value <= 1.0):
                print("ERROR: Invalid {} value in pair {}: {}".format(metric, pair_key, value))
                return False

        top_streets = pair_data['top_shared_streets']
        if not isinstance(top_streets, list):
            print("ERROR: top_shared_streets not a list in pair {}".format(pair_key))
            return False

        samples_checked += 1
        if samples_checked >= sample_count:
            break

    print("✓ city_similarities.json: {} city pairs validated".format(sim_pairs))
    return True

def validate_data_consistency(valid_city_codes, unique_streets):
    """Validate consistency across all data files."""
    print("Validating data consistency...")

    try:
        with open('data/processed/cities.json', 'r') as f:
            cities_data = json.load(f)
    except IOError:
        return False

    # Verify that street index and cities data match
    total_city_streets_from_cities = 0
    for city_data in cities_data.values():
        total_city_streets_from_cities += city_data['street_count']

    total_city_streets_from_index = 0
    street_index_data = None

    try:
        with open('data/processed/street_index.json', 'r') as f:
            street_index_data = json.load(f)
    except IOError:
        return False

    for cities_list in street_index_data.values():
        total_city_streets_from_index += len(cities_list)

    if total_city_streets_from_cities != total_city_streets_from_index:
        print("ERROR: Street count mismatch between cities.json ({}) and street_index.json ({})".format(
            total_city_streets_from_cities, total_city_streets_from_index))
        return False

    print("✓ Data consistency: {} total street-city relationships".format(total_city_streets_from_cities))
    return True

def main():
    """Main validation function."""
    print("Starting City Street Names Output Validation")
    print("=" * 50)

    # Create output directory if needed
    if not os.path.exists('data/processed'):
        print("ERROR: data/processed directory not found")
        return False

    # Validate cities data
    cities_result = validate_cities_json()
    if not cities_result:
        return False
    valid_city_codes, total_streets = cities_result

    print()

    # Validate street index
    streets_result = validate_street_index_json(valid_city_codes)
    if not streets_result:
        return False
    unique_streets = streets_result

    print()

    # Validate rarity weights
    if not validate_rarity_weights_json(unique_streets):
        return False

    print()

    # Validate city similarities
    if not validate_city_similarities_json(valid_city_codes):
        return False

    print()

    # Validate overall consistency
    if not validate_data_consistency(valid_city_codes, unique_streets):
        return False

    print()
    print("All validations passed!")
    print("✓ {} cities processed".format(len(valid_city_codes)))
    print("✓ {} unique street names".format(len(unique_streets)))
    print("✓ {} city pairs analyzed".format(len(valid_city_codes) * (len(valid_city_codes) - 1) // 2))
    print("✓ {} street-city mappings".format(sum(len(data['normalized_keys']) for data in json.load(open('data/processed/cities.json', 'r')).values())))

    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
