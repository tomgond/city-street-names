import json

# Load and validate cities.json
with open('data/processed/cities.json', 'r', encoding='utf-8') as f:
    cities = json.load(f)

print(f"Number of cities: {len(cities)}")

for code, data in list(cities.items())[:5]:
    print(f"City {code}: {data}")

import zipfile

# Try to load city_similarities.json
with open('data/processed/city_similarities.json', 'r', encoding='utf-8') as f:
    sims = json.load(f)

print(f"Number of similarity pairs: {len(sims)}")

# Take a sample
sample = list(sims.items())[0]
print(f"Sample pair: {sample}")
