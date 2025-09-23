# Agent Guidelines for `city-street-names`

## Project Overview & Data Flow

This project analyzes similarity between Israeli street names and publishes the results as a static web experience. The processing flow is:

1. **Normalization (`src/normalization/norm_data.py`)** – load the raw government CSV (`street_names.csv`), strip prefixes (רח׳, רחוב, שד׳, דרך, שביל, כיכר), remove punctuation, normalize final letters (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ), unify hyphenation ("בן-גוריון" → "בן גוריון"), and optionally drop leading ה- to build stable `norm_key`/`norm_display` pairs. The normalized rows are saved as `data/raw/norm.csv`.
2. **Aggregation (`src/aggregation/build_data.py`)** – load the normalized CSV, compute rarity weights (`1/log(1+city_count)`), derive Jaccard and weighted Jaccard similarities, detect communities, and export processed datasets (`cities.json`, `street_index.json`, `rarity_weights.json`, `similarity_top.json`, optionally `city_similarities.json`). The script also mirrors the fresh JSON into `frontend/public/data/processed/` so the web app can load them.
3. **Frontend (`frontend/`)** – the static site (built with Vite) renders the analytics: network graph and heatmap on the home view, similarity bar charts on a city view, per-street listings on a street view, and a Fuse.js-powered fuzzy search that jumps to `/street/:key`. Leaflet is reserved for an optional map view once city coordinates are supplied.

## GitHub Actions & Generated Artifacts

The `build-and-deploy` GitHub Actions workflow installs Python + Node dependencies, runs `python src/aggregation/build_data.py`, builds the Vite frontend, and uploads the static `frontend/dist` bundle to GitHub Pages. **Do not commit generated JSON artifacts** (`data/processed/*.json`, `frontend/public/data/processed/*.json`) to the repository—let the workflow create them during CI/CD.

## Key Libraries

* **Python**: `networkx` (community detection + graph metrics for city similarity).
* **Frontend**: `d3` (visualizations such as network graphs, heatmaps, bar charts), `fuse.js` (Hebrew fuzzy search), `leaflet` (interactive map view). Vite orchestrates the build, with ESLint keeping the JS tidy.

Follow these guidelines when editing files in this repository. If you add new processing steps or outputs, update this document accordingly.
