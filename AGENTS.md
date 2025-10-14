# Agent Guidelines for `city-street-names`

## Project Overview & Data Flow

This project analyzes similarity between Israeli street names and publishes the results as a static web experience. The processing flow is:

1. **Normalization (`src/normalization/norm_data.py`)** – load the raw government CSV (`street_names.csv`), strip prefixes (רח׳, רחוב, שד׳, דרך, שביל, כיכר), remove punctuation, normalize final letters (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ), unify hyphenation ("בן-גוריון" → "בן גוריון"), and optionally drop leading ה- to build stable `norm_key`/`norm_display` pairs. The normalized rows are saved as `data/raw/norm.csv`.
2. **Aggregation (`src/aggregation/build_data.py`)** – load the normalized CSV, compute rarity weights (`1/log(1+city_count)`), derive Jaccard and weighted Jaccard similarities, detect communities, and export processed datasets (`cities.json`, `street_index.json`, `rarity_weights.json`, `similarity_top.json`, optionally `city_similarities.json`). The script also mirrors the fresh JSON into `frontend/public/data/processed/` so the web app can load them.
3. **Frontend (`frontend/`)** – the static site (built with Vite) renders the analytics: network graph and heatmap on the home view, similarity bar charts on a city view, per-street listings on a street view, and a Fuse.js-powered fuzzy search that jumps to `/street/:key`. Leaflet is reserved for an optional map view once city coordinates are supplied.

## Developer Workflow Expectations

* Use Python 3.11 when running scripts locally (`py -3.11 <file>` on Windows environments).
* Prefer `rg`/`ripgrep` for code search. Avoid `grep -R` or `ls -R` in large directories—they slow down the session.
* Before editing, skim recent commits (`git log --oneline`) to understand feature context. Many UX tweaks build on each other.
* Keep changes tightly scoped. Refrain from mass reformatting or renaming unless the task explicitly requires it; large diffs slow down review and risk regressions.

## Running & Verifying Code

* **Python data pipeline**: from the repo root run `python -m src.aggregation.build_data` (or `py -3.11 src/aggregation/build_data.py`) after installing deps with `python -m pip install -r requirements.txt`. The script reads from `data/raw` and writes processed JSON files. Let CI generate artifacts—do **not** commit files under `data/processed/` or `frontend/public/data/processed/`.
* **Frontend quality checks**: use `npm --prefix frontend run lint` for static analysis and `npm --prefix frontend run build` if you need to ensure the Vite bundle still compiles. These commands are fast and catch most issues early.
* **Python style**: follow the existing module structure. Prefer pure functions and keep helper utilities close to their usage rather than scattering new modules unless there is a clear reuse story. The codebase does not currently enforce auto-formatters—match surrounding indentation (4 spaces in Python, 2 spaces in frontend JS/CSS).

## Coding Conventions & Design Guardrails

* Maintain the warm cream palette already defined in `frontend/src/styles.css` when adjusting colors. If you must introduce a new color, ensure sufficient contrast with `var(--text)` and document the choice in comments.
* Frontend DOM manipulation happens in `frontend/src/main.js` with vanilla JS + D3. Extend existing utility sections instead of rewriting large blocks-incremental changes are easier to reason about and keep performance steady.
* When updating search or filtering logic, remember that Fuse.js is initialized once. Cache-heavy computations (e.g., building large arrays) should remain lazily evaluated to keep initial load times quick.
* Avoid mutating `node_modules/` or committed datasets (`street_names.csv`, `norm.csv`) unless the task explicitly involves data updates.
* Document any new environment variables or CLI flags directly in this file so future agents can reproduce your work quickly.

## Community Detection & Similarity Metrics (Updated Oct 2025)

### Backend (`src/aggregation/build_data.py`)

The pipeline now supports multiple similarity metrics when determining city communities. Parameters can be supplied via environment variables (preferred) or by editing `build_data.py` defaults.

| Env variable | Default | Meaning |
| --- | --- | --- |
| `COMMUNITY_WEIGHT_MODE` | `inverse_df` | Determines how edges are weighed when building the city similarity graph. Supported values: `weighted_jaccard`, `jaccard`, `inverse_df`, `binary_cosine`, `tfidf_cosine`. |
| `COMMUNITY_IDF_POWER` | `1.0` | Exponent applied to inverse document frequency when using `inverse_df` or `tfidf_cosine`. Higher values emphasize rare streets. |
| `COMMUNITY_MIN_SHARED` | `3` | Minimum number of shared streets required before keeping an edge. |
| `COMMUNITY_MIN_WEIGHT` | `0.0` | Minimum edge weight (after metric calculation) required to keep an edge. |
| `COMMUNITY_RESOLUTION` | `1.2` | Louvain resolution. Lower values produce fewer, larger communities; higher values produce more, smaller communities. |
| `COMMUNITY_MAX_DF_FRACTION` | `0.2` | Drop streets that appear in more than this fraction of cities before building the community graph. Use `0` to disable. |

Additional similarity trimming controls:

| Env variable | Default | Meaning |
| --- | --- | --- |
| `CITY_SIMILARITY_GRAPH_TOP_N` | `0` | Maximum neighbors retained per city *before* community detection (falls back to legacy `CITY_SIMILARITY_TOP_N` if set). |
| `CITY_SIMILARITY_EXPORT_TOP_N` | `25` | Maximum neighbors exported per city in `similarity_top.json`. Entries are sorted by the active community weight metric. |
> Legacy env var `CITY_SIMILARITY_TOP_N` is still read as a fallback, but prefer the new names so future runs stay consistent.

After community detection, the script annotates each entry in `similarity_top.json` with additional metrics to keep backend and frontend in sync:

* `inverse_df`, `binary_cosine`, `tfidf_cosine`: Numeric scores matching the calculation used by `COMMUNITY_WEIGHT_MODE`.
* `communityWeight`: The metric actually used during detection (one of the above or the legacy Jaccard scores).
* `community_config.json`: Exported alongside the other datasets with the effective parameters (weight mode, min weight, IDF power, etc.) used during the run. The frontend consumes this to choose default display settings. The file now also records `graphTopLimit`, `neighborPercentile`, `exportNeighborLimit`, and `exportNeighborAverage` so you can see how aggressively the similarity lists were trimmed before shipping to the browser.

### Frontend (`frontend/src/main.js`, `frontend/index.html`)

The graph view now adapts automatically to the backend’s chosen metric:

* On load, `community_config.json` is fetched and the available metrics are inferred from `similarity_top.json`.
* The metric dropdown is populated dynamically (no longer hard-coded to Jaccard options). The active value defaults to the backend’s `communityWeight`.
* Graph rendering, tooltip text, node scoring, and “has connection” checks all respect the selected metric. Changing the dropdown rerenders both the preview and full graph.
* Edge pruning still applies (limit controlled by `maxLinks` argument), but now uses the same metric as community detection, keeping the structure consistent across tooling and production.

### Reproducing the New Default Behaviour

```
COMMUNITY_WEIGHT_MODE=inverse_df \
COMMUNITY_IDF_POWER=1.0 \
COMMUNITY_MIN_SHARED=3 \
COMMUNITY_MIN_WEIGHT=0.0 \
COMMUNITY_RESOLUTION=1.2 \
COMMUNITY_MAX_DF_FRACTION=0.2 \
CITY_SIMILARITY_EXPORT_TOP_N=25 \
python -m src.aggregation.build_data
```

This matches the “Winner” configuration from the exploration tool. Adjust the env vars to experiment; the frontend will automatically reflect any changes after the JSON files are regenerated.

## GitHub Actions & Generated Artifacts

The `build-and-deploy` GitHub Actions workflow installs Python + Node dependencies, runs `python src/aggregation/build_data.py`, builds the Vite frontend, and uploads the static `frontend/dist` bundle to GitHub Pages. **Do not commit generated JSON artifacts** (`data/processed/*.json`, `frontend/public/data/processed/*.json`) to the repository—let the workflow create them during CI/CD.

Follow these guidelines when editing files in this repository. If you add new processing steps or outputs, update this document accordingly.
