Live URL: https://z3roll.github.io/cs5346-as2/ — or locally: `cd src && python3 -m http.server 8000` then open http://localhost:8000/

# CS5346 Assignment 2 — COVID-19 Weekly Cases: A Bias-Aware Redesign

**Student:** Zhiyu Yuan (A0339573R)
**Course:** CS5346 Information Visualisation

## Case Choice

**Case A — OWID COVID-19 Weekly Cases Map.** Phase 2 is a bias-aware redesign built as an interactive proportional symbol map. Circles replace the original choropleth's filled polygons; circle area and color both encode the current metric (per-100k default, togglable to raw). Four selectable binning methods — Quantile, Jenks, Equal interval, and OWID Log (the original grapher's fixed 10^n thresholds) — let the viewer see how classing choice reshapes the story, directly targeting Phase 1 Biases 1, 2, and 3 in one integrated view.

## Tech Stack

- HTML + vanilla JavaScript (no build step)
- [D3.js v7](https://d3js.org/) (loaded from jsDelivr CDN)
- [topojson-client v3](https://github.com/topojson/topojson-client) (loaded from jsDelivr CDN)
- Google Fonts: Syne, DM Sans, IBM Plex Mono
- Python 3.10+ (data preparation only; not needed at runtime)

## Dependencies & Setup

**Runtime:** zero local dependencies. Everything is pulled from CDNs when the page loads. Any modern browser (Chrome, Firefox, Safari, Edge) works.

**Data preparation (optional, only if rebuilding the JSON):** Python 3.10+ standard library; the script at `src/tools/build_covid_weekly.py` reads `weekly-covid-cases-with-population.csv` (OWID export merged with OWID's population-by-year dataset) and writes `src/data/covid_weekly.json`.

## Access

### Primary (live)
https://z3roll.github.io/cs5346-as2/

### Local run
A local HTTP server is required because browsers block `fetch` on `file://` URLs.

```bash
cd src
python3 -m http.server 8000
# then open http://localhost:8000/ in any modern browser
```

Any equivalent static server works (Node `http-server`, `serve`, Caddy, etc.) — just point it at the `src/` directory.

## Interactions

- **Metric toggle** (Per 100k / Raw) — fixes Phase 1 Bias 1; both circle size and color follow the toggle
- **Bin toggle** (Quantile / Jenks / Equal / OWID Log) — fixes Phase 1 Bias 3; `OWID Log` uses the literal 10^n thresholds pulled from the OWID grapher's own `colorScale` config for direct head-to-head comparison
- **Time slider + play/pause** — scrub weekly, 2020-W02 to 2026-W08
- **Hover tooltip** — shows per-100k, weekly raw cases, and population simultaneously (defense against framing bias)
- **Ranked country panel** (right side) — live search, linked highlighting with the map, bar length proportional to current value
- **Zoom / pan** — scroll to zoom, double-click to reset
- **Keyboard** — Space to play/pause, ← → to step weeks

## Directory Layout

```
A0339573R_A2.zip
├── README.md                  — this file
├── phase1_diagnosis.pdf       — Phase 1 Structured Diagnosis (both cases)
├── phase3_rationale.pdf       — Phase 3 Design Rationale & Self-Audit
├── src/                       — Phase 2 interactive redesign source
│   ├── index.html
│   ├── style.css
│   ├── js/
│   │   └── main.js
│   ├── data/                  — data consumed by the running page
│   │   ├── covid_weekly.json
│   │   ├── countries-110m.json
│   │   └── iso_mapping.json
│   └── tools/
│       └── build_covid_weekly.py   — data-prep script (optional)
└── data/                      — final processed dataset (per §3.1 Req. 5)
    ├── covid_weekly.json
    ├── countries-110m.json
    └── iso_mapping.json
```

## Data Provenance

- **COVID weekly cases:** [Our World in Data COVID-19 Dataset](https://github.com/owid/covid-19-data), WHO-derived, CC BY 4.0
- **Population:** OWID population-by-year dataset, merged on (Code, Year)
- **Country boundaries:** Natural Earth 110m (via [world-atlas](https://github.com/topojson/world-atlas))

Documented data transformations (see Section A of `phase3_rationale.pdf` for full detail):

1. Aggregate rows (Asia, Europe, European Union (27), World, High-income countries, etc.) dropped — filtered by `Code` length != 3.
2. Pitcairn (PCN) dropped — no entry in OWID's population dataset.
3. Per-million values rescaled to **per-100k population** (public-health standard unit).
4. Weekly sampling: only ISO Sunday rows retained so each value spans a full Monday–Sunday window; keeps the JSON payload under 2.2 MB.
