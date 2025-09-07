# Project: Israeli Street Name Similarity Website

## Goals

* Analyze street name similarities across all Israeli cities.
* Provide city-to-city comparison and clustering.
* Add per-street search view: see which cities have a given name.
* Correlate with socio-political attributes later.
* Deliver as a lightweight static site (Python preprocessing + JS frontend).

---

## Data Sources

* **Street list**: Israeli government open data — all streets, with city + street code.
* **Synonyms list**: maps alternative/old names to canonical street codes.
* **Optional**: city metadata (population, coordinates, socio-economic rank).

---

## Data Processing (Python)

1. **Load** street CSV + synonym CSV.
2. **Normalize names**:

   * Strip prefixes (רח׳, רחוב, שד׳, דרך, שביל, כיכר).
   * Remove punctuation, normalize finals (ך→כ, ם→מ, ן→נ, ף→פ, ץ→צ).
   * Normalize hyphenation/spaces ("בן-גוריון" → "בן גוריון").
   * Map via synonyms if possible.
3. **Build sets**: `{city_code: {normalized_names}}`.
4. **Compute stats**:

   * Jaccard between cities.
   * Weighted Jaccard (rarity = 1/log(1+city\_count)).
   * Top-N matches per city.
   * Inverted index: `{street_name: [cities...]}`.
5. **Export JSON**:

   * `cities.json` (id, name, cluster\_id?).
   * `similarity_top.json` (top matches per city).
   * `name_index.json` (street → cities, variants).
   * `name_meta.json` (counts, rarity).

---

## Frontend (JS + D3 + Fuse.js)

* **Home**:

  * Network graph: cities as nodes, edges for Jaccard ≥ τ.
  * Heatmap: similarity between top 50 cities.
* **City Page**:

  * Bar chart of top-10 similar cities.
  * Shared street list (top examples).
* **Street Page**:

  * Show display name + variants.
  * List all cities with this street.
  * Optional map view (Leaflet, using `city_coords.json`).
* **Search**:

  * Fuse.js fuzzy search (Hebrew).
  * Jump to `/street/:key` page.

---

## Visualizations

* **Network graph**: clusters of similar cities.
* **Heatmap**: similarity matrix (pairwise Jaccard).
* **Bar charts**: similarity per city.
* **Street map**: all cities with a given street.
* **Venn/overlap lists**: show shared street names between two cities.

---

## Next Steps

1. **Data prep**: Write `build_data.py` with normalization + JSON export.
2. **QA**: Unit tests for normalization edge cases.
3. **Frontend scaffold**: Vite + vanilla JS (or React). Add D3, Fuse.js, Leaflet.
4. **Integrate data**: load JSONs into visualizations.
5. **Street search**: implement `/street/:key` route.
6. **Polish UI**: RTL support, HE/EN labels.
7. **Deploy**: Netlify/GitHub Pages (static hosting).

---

## Future Extensions

* Socio-economic overlays (scatterplots).
* Category tagging of street names (rabbis, plants, etc.).
* Timeline view if historical data added.
