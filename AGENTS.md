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
* Frontend DOM manipulation happens in `frontend/src/main.js` with vanilla JS + D3. Extend existing utility sections instead of rewriting large blocks—incremental changes are easier to reason about and keep performance steady.
* When updating search or filtering logic, remember that Fuse.js is initialized once. Cache-heavy computations (e.g., building large arrays) should remain lazily evaluated to keep initial load times quick.
* Avoid mutating `node_modules/` or committed datasets (`street_names.csv`, `norm.csv`) unless the task explicitly involves data updates.
* Document any new environment variables or CLI flags directly in this file so future agents can reproduce your work quickly.

## GitHub Actions & Generated Artifacts

The `build-and-deploy` GitHub Actions workflow installs Python + Node dependencies, runs `python src/aggregation/build_data.py`, builds the Vite frontend, and uploads the static `frontend/dist` bundle to GitHub Pages. **Do not commit generated JSON artifacts** (`data/processed/*.json`, `frontend/public/data/processed/*.json`) to the repository—let the workflow create them during CI/CD.

Follow these guidelines when editing files in this repository. If you add new processing steps or outputs, update this document accordingly.
