# CS5346 Assignment 2 — COVID-19 Weekly Cases: A Bias-Aware Redesign

**Author:** z3roll

**Case:** A (OWID COVID-19 Weekly Cases Map)
**Tech stack:** D3.js v7, TopoJSON, vanilla HTML/CSS/JS
**Dependencies:** None (all libraries loaded from CDN)

## Live demo

https://z3roll.github.io/cs5346-as2/

## Run locally

```bash
python3 -m http.server
# then open http://localhost:8000/
```

A local HTTP server is required because browsers block `fetch` on `file://` URLs.

## Data

- COVID-19 weekly cases: pre-processed from [OWID COVID-19 dataset](https://github.com/owid/covid-19-data), CC BY 4.0
- Country boundaries: Natural Earth 110m
