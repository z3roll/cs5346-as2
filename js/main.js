/**
 * COVID-19 Symbol Map Redesign — Dark "Mission Control" Theme
 *
 * Phase 1 biases remediated (all three, integrated):
 *
 *   Bias 1 — Raw counts without population normalization
 *     → Per-100k default + explicit Metric toggle. The same toggle
 *       drives both circle size AND fill color so the two visual
 *       channels agree.
 *
 *   Bias 2 — Area-size dominance from choropleth encoding
 *     → Switched from choropleth to proportional symbol map.
 *       Country polygons are now ghost outlines carrying NO data;
 *       every country gets a circle placed at its polygon centroid
 *       whose area is proportional to the current metric value.
 *       Russia's landmass no longer dictates visual weight.
 *
 *   Bias 3 — Fixed log color bins compress within-bin variation
 *     → Four selectable binning methods: Quantile / Jenks / Equal /
 *       OWID Log (the original 10^n breaks). Viewers can directly
 *       see how binning choice changes the story; OWID Log is
 *       included so the redesign can be compared head-to-head with
 *       the original on the same data.
 *
 * Extras beyond the standalone OWID grapher page:
 *   - Metric toggle (raw / per-100k)        ← OWID grapher lacks this
 *   - Adjustable color-bin method           ← OWID grapher lacks this
 *   - Ranked country list w/ live search    ← OWID grapher lacks this
 *   - Linked highlighting map ↔ list
 *   - Tooltip shows raw + per-100k + population simultaneously so
 *     the viewer isn't anchored to a single indicator.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  metric: "pm",            // "pm" = per-100k  |  "raw" = raw counts
  binMethod: "quantile",   // "quantile" | "jenks" | "equal" | "owidlog"
  weekIndex: 0,
  playing: false,
  playInterval: null,
  covidData: null,
  topoData: null,
  isoMapping: null,
  dates: [],
  geoFeatures: null,
  highlightedCountry: null,
  searchQuery: "",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NUM_BINS = 6;
const COLOR_PALETTE = d3.schemeYlOrRd[NUM_BINS + 1].slice(1);
const ZERO_COLOR = "#2a2518";
const PLAY_SPEED_MS = 200;

// Symbol radius bounds in pixels (area-proportional via sqrt scale).
// Upper bound kept modest so dense regions (Europe) stay readable without
// requiring aggressive force-collide relaxation that would displace circles
// away from their true geographic positions.
const RADIUS_MIN = 1.0;
const RADIUS_MAX = 18;

// OWID-style "manual" log thresholds — the actual config we pulled from
// the grapher page. Raw uses the literal OWID breaks; per-100k uses the
// same log-10 pattern rescaled to the per-100k value range.
const OWID_LOG_THRESHOLDS = {
  raw: [10, 100, 1000, 10000, 100000],
  pm:  [1, 10, 100, 1000, 10000],
};

// Bump when data/*.json is regenerated so caches don't serve stale copies.
const DATA_VERSION = "2026-04-10a";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const v = `?v=${DATA_VERSION}`;
    const [covidData, topoData, isoMapping] = await Promise.all([
      d3.json("data/covid_weekly.json" + v),
      d3.json("data/countries-110m.json" + v),
      d3.json("data/iso_mapping.json" + v),
    ]);

    state.covidData = covidData;
    state.topoData = topoData;
    state.isoMapping = isoMapping;
    state.dates = covidData.dates;

    state.numericToAlpha3 = {};
    state.alpha3ToNumeric = {};
    for (const [a3, num] of Object.entries(isoMapping)) {
      state.numericToAlpha3[num] = a3;
      state.alpha3ToNumeric[a3] = num;
    }

    state.geoFeatures = topojson.feature(
      topoData, topoData.objects.countries
    ).features;

    state.featureById = new Map();
    state.geoFeatures.forEach(f => {
      state.featureById.set(String(f.id).padStart(3, "0"), f);
    });

    // Radius reference: 99th-percentile value across all (country, week) for
    // each metric. Radius is sqrt(value)-mapped with this as the upper anchor
    // and clamped, so a handful of micro-state outliers (Saint Helena etc.)
    // don't collapse the rest of the world to invisibility, while still
    // showing those outliers as max-size circles. The domain is stable across
    // time scrubbing so circle size is visually comparable week-to-week.
    state.radiusRef = computeRadiusRef(covidData, state.numericToAlpha3);

    const slider = document.getElementById("time-slider");
    slider.max = state.dates.length - 1;
    const defaultIdx = Math.min(100, state.dates.length - 1);
    slider.value = defaultIdx;
    state.weekIndex = defaultIdx;

    document.getElementById("loading").remove();

    buildMap();
    updateMap();
    updateDateDisplay();
    bindControls();

    window.addEventListener("resize", debounce(() => {
      buildMap();
      updateMap();
    }, 200));

  } catch (err) {
    console.error("Init failed:", err);
    const ld = document.getElementById("loading");
    if (ld) ld.innerHTML = "<span>Failed to load data.</span>";
  }
}

// Collect every (country, week) value into an array, sort, return p99 for
// both metrics. ~70k values, so fine to do at load time.
function computeRadiusRef(covidData, numericToAlpha3) {
  const raw = [];
  const pm = [];
  for (const c of Object.values(covidData.countries)) {
    for (const wk of Object.values(c.weeks || {})) {
      if (wk.r != null && wk.r > 0) raw.push(wk.r);
      if (wk.p != null && wk.p > 0) pm.push(wk.p);
    }
  }
  raw.sort(d3.ascending);
  pm.sort(d3.ascending);
  return {
    raw: d3.quantileSorted(raw, 0.99) || 1,
    pm:  d3.quantileSorted(pm,  0.99) || 1,
  };
}

// ---------------------------------------------------------------------------
// Map Build
// ---------------------------------------------------------------------------
function buildMap() {
  const container = document.getElementById("map-container");
  d3.select(container).select("svg").remove();
  d3.select(container).selectAll(".legend-container,.bin-info").remove();

  const w = container.clientWidth;
  const h = container.clientHeight || 480;

  const svg = d3.select(container)
    .append("svg")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Equal Earth: area-preserving. Not the main Bias-2 fix (the symbol layer
  // is) but still better than Mercator for the ghost base layer so the
  // ghost polygons have honest proportions.
  const projection = d3.geoEqualEarth()
    .fitSize([w - 16, h - 16], { type: "Sphere" })
    .translate([w / 2, h / 2]);

  const path = d3.geoPath(projection);
  state.svg = svg;
  state.path = path;
  state.width = w;
  state.height = h;

  const g = svg.append("g").attr("class", "map-g");

  // Ocean sphere + graticule
  g.append("path").datum({ type: "Sphere" }).attr("class", "sphere").attr("d", path);
  g.append("path").datum(d3.geoGraticule10()).attr("class", "graticule").attr("d", path);

  // Ghost country layer — outlines only, no data encoding. Provides
  // geographic context so users can identify where symbols belong without
  // the area-size bias that a filled choropleth would reintroduce.
  g.selectAll(".country")
    .data(state.geoFeatures)
    .join("path")
    .attr("class", "country")
    .attr("d", path)
    .attr("data-id", d => String(d.id).padStart(3, "0"));

  // Symbol layer — this is where the data lives.
  const symbolLayer = g.append("g").attr("class", "symbol-layer");
  state.symbolLayer = symbolLayer;

  // Pre-compute projected centroids once per build. For null/undefined
  // centroids (features with no projected geometry) we fall back to NaN
  // which updateMap will skip.
  state.centroids = new Map();
  for (const f of state.geoFeatures) {
    const c = path.centroid(f);
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      state.centroids.set(f.id, c);
    }
  }

  // Zoom & pan
  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => { g.attr("transform", event.transform); });
  svg.call(zoom);
  svg.on("dblclick.zoom", () => {
    svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
  });

  state.mapGroup = g;
}

// ---------------------------------------------------------------------------
// Map Update
// ---------------------------------------------------------------------------
function updateMap() {
  const weekKey = state.dates[state.weekIndex].key;
  const metric = state.metric;
  const countries = state.covidData.countries;

  const values = [];
  const cv = new Map(); // feature id -> entry
  const rows = [];      // {feature, entry, cx, cy}

  for (const f of state.geoFeatures) {
    const nid = String(f.id).padStart(3, "0");
    const a3 = state.numericToAlpha3[nid];
    if (!a3 || !countries[a3]) { cv.set(f.id, null); continue; }

    const c = countries[a3];
    const wd = c.weeks[weekKey];
    if (!wd) { cv.set(f.id, null); continue; }

    const val = metric === "pm" ? wd.p : wd.r;
    const entry = { raw: wd.r, pm: wd.p, name: c.name, pop: c.pop, value: val, alpha3: a3 };
    cv.set(f.id, entry);

    if (val != null && val > 0) values.push(val);

    const cent = state.centroids.get(f.id);
    if (cent) rows.push({ feature: f, entry, cx: cent[0], cy: cent[1] });
  }

  const colorScale = buildColorScale(values, state.binMethod, metric);
  const radiusScale = d3.scaleSqrt()
    .domain([0, state.radiusRef[metric]])
    .range([RADIUS_MIN, RADIUS_MAX])
    .clamp(true);

  // Sort rows by value desc so tiny circles paint last (on top) — prevents
  // micro-states from hiding behind giant neighbours, and makes the biggest
  // circles drawn first (behind) so the smaller ones remain clickable.
  // We intentionally DO NOT run force-collide: displacing circles away from
  // their true centroid would reintroduce geographic distortion. Dense
  // regions (Europe) use overlap + smallest-on-top instead.
  rows.sort((a, b) => (b.entry.value || 0) - (a.entry.value || 0));
  rows.forEach(d => { d.x = d.cx; d.y = d.cy; });

  // Data-join on the symbol layer
  const sel = state.symbolLayer.selectAll("circle.symbol")
    .data(rows, d => d.entry.alpha3);

  sel.exit().remove();

  const enter = sel.enter().append("circle")
    .attr("class", "symbol")
    .attr("data-a3", d => d.entry.alpha3)
    .on("mouseover", onSymbolHover)
    .on("mousemove", onSymbolMove)
    .on("mouseout", onSymbolOut);

  enter.merge(sel)
    .attr("cx", d => d.x)
    .attr("cy", d => d.y)
    .attr("r", d => {
      const v = d.entry.value;
      if (v == null || v <= 0) return 0;   // suppress no-data / zero
      return radiusScale(v);
    })
    .attr("fill", d => {
      const v = d.entry.value;
      if (v == null) return "none";
      if (v === 0) return "none";
      return colorScale(v);
    });

  state.currentCountryValues = cv;
  state.currentColorScale = colorScale;
  state.currentRadiusScale = radiusScale;
  updateLegend(colorScale, radiusScale, values);
  updateBinInfo();
  updateRankedList();
}

// ---------------------------------------------------------------------------
// Color Scale
// ---------------------------------------------------------------------------
function buildColorScale(values, method, metric) {
  if (!values.length) return () => ZERO_COLOR;

  if (method === "owidlog") {
    // Fixed OWID-style log thresholds (matching what we pulled from the
    // grapher config). Clamping is implicit in scaleThreshold.
    const thresholds = OWID_LOG_THRESHOLDS[metric] || OWID_LOG_THRESHOLDS.raw;
    return d3.scaleThreshold().domain(thresholds).range(COLOR_PALETTE);
  }

  const sorted = values.slice().sort(d3.ascending);

  if (method === "quantile") {
    return d3.scaleQuantile().domain(sorted).range(COLOR_PALETTE);
  }

  if (method === "equal") {
    // Quantize over the full value range. Prone to domination by a single
    // outlier — that's why we expose multiple methods; this one is here so
    // users can SEE the bias, per our Phase 1 Bias 3 analysis.
    return d3.scaleQuantize().domain(d3.extent(sorted)).range(COLOR_PALETTE);
  }

  if (method === "jenks") {
    const breaks = jenksBreaks(sorted, NUM_BINS);
    // breaks includes min & max; middle elements are the thresholds.
    const thresholds = breaks.slice(1, -1);
    return d3.scaleThreshold().domain(thresholds).range(COLOR_PALETTE);
  }

  return d3.scaleQuantile().domain(sorted).range(COLOR_PALETTE);
}

// ---------------------------------------------------------------------------
// Jenks natural-breaks (Fisher-Jenks optimization, classic DP)
// Returns [min, break1, break2, ..., max]. Length = nclass + 1.
// Expects `data` to be sorted ascending.
// ---------------------------------------------------------------------------
function jenksBreaks(data, nclass) {
  const n = data.length;
  if (n <= nclass) {
    // Degenerate: just return data as its own breaks, padded
    const out = data.slice();
    while (out.length < nclass + 1) out.push(data[n - 1]);
    return out;
  }

  // mat1[i][j] stores the lower class limit index for class j ending at point i
  // mat2[i][j] stores the variance
  const mat1 = Array.from({ length: n + 1 }, () => new Array(nclass + 1).fill(0));
  const mat2 = Array.from({ length: n + 1 }, () => new Array(nclass + 1).fill(0));

  for (let i = 1; i <= nclass; i++) {
    mat1[1][i] = 1;
    mat2[1][i] = 0;
    for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
  }

  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      s2 += val * val;
      s1 += val;
      w += 1;
      const variance = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= nclass; j++) {
          if (mat2[l][j] >= variance + mat2[i4][j - 1]) {
            mat1[l][j] = i3;
            mat2[l][j] = variance + mat2[i4][j - 1];
          }
        }
      }
    }
    mat1[l][1] = 1;
    mat2[l][1] = (function() {
      let ss = 0, su = 0, ww = 0;
      for (let m = 0; m < l; m++) { const v = data[m]; ss += v * v; su += v; ww++; }
      return ss - (su * su) / ww;
    })();
  }

  const kclass = new Array(nclass + 1);
  kclass[nclass] = data[n - 1];
  kclass[0] = data[0];
  let k = n;
  for (let j = nclass; j >= 2; j--) {
    const id = mat1[k][j] - 1;
    kclass[j - 1] = data[id];
    k = mat1[k][j] - 1;
  }
  return kclass;
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function updateLegend(colorScale, radiusScale, values) {
  const ct = document.getElementById("map-container");
  d3.select(ct).selectAll(".legend-container").remove();

  const label = state.metric === "pm"
    ? "WEEKLY CASES / 100K POPULATION"
    : "WEEKLY CASES (RAW COUNT)";

  const leg = d3.select(ct).append("div").attr("class", "legend-container");
  leg.append("div").attr("class", "legend-title").text(label);

  // Color bin legend
  const items = leg.append("div").attr("class", "legend-items");
  if (values.length) {
    const thresholds = getThresholds(colorScale, values);
    // For fixed-threshold scales (OWID Log) the bins are open-ended: the
    // lowest bin is "below first threshold" and the highest is "≥ last
    // threshold". For interpolating scales (quantile / jenks / equal) the
    // thresholds sit BETWEEN observed min and max, so we bracket with them.
    const isFixed = state.binMethod === "owidlog";
    const minV = d3.min(values);
    const maxV = d3.max(values);
    const bins = [];
    for (let i = 0; i < COLOR_PALETTE.length; i++) {
      let label;
      if (isFixed) {
        const lo = i === 0 ? null : thresholds[i - 1];
        const hi = i < thresholds.length ? thresholds[i] : null;
        if (lo == null) label = `< ${fmtShort(hi)}`;
        else if (hi == null) label = `≥ ${fmtShort(lo)}`;
        else label = `${fmtShort(lo)} – ${fmtShort(hi)}`;
      } else {
        const edges = [minV, ...thresholds, maxV];
        const lo = edges[i];
        const hi = edges[i + 1] != null ? edges[i + 1] : edges[edges.length - 1];
        label = `${fmtShort(lo)} – ${fmtShort(hi)}`;
      }
      bins.push({ color: COLOR_PALETTE[i], label });
    }
    bins.reverse().forEach(b => {
      const it = items.append("div").attr("class", "legend-item");
      it.append("div").attr("class", "legend-swatch").style("background", b.color);
      it.append("span").attr("class", "legend-label").text(b.label);
    });
  }
  // No data
  const nd = items.append("div").attr("class", "legend-item");
  nd.append("div").attr("class", "legend-swatch no-data-swatch");
  nd.append("span").attr("class", "legend-label").text("No data");

  // Size legend — a few reference circles
  const sizeLeg = leg.append("div").attr("class", "size-legend");
  sizeLeg.append("div").attr("class", "size-legend-title").text("Circle area = value");
  const ref = state.radiusRef[state.metric];
  const samples = [ref * 0.05, ref * 0.25, ref];
  const sizeItems = sizeLeg.append("div").attr("class", "size-legend-items");
  samples.forEach(v => {
    const r = radiusScale(v);
    const g = sizeItems.append("div").attr("class", "size-legend-item");
    const svg = g.append("svg")
      .attr("width", RADIUS_MAX * 2 + 2)
      .attr("height", RADIUS_MAX * 2 + 2);
    svg.append("circle")
      .attr("cx", RADIUS_MAX + 1)
      .attr("cy", RADIUS_MAX + 1)
      .attr("r", r)
      .attr("class", "size-legend-ref");
    g.append("span").text(fmtShort(v));
  });
}

function getThresholds(colorScale, values) {
  if (state.binMethod === "quantile" && colorScale.quantiles) {
    return colorScale.quantiles();
  }
  if (state.binMethod === "equal" && colorScale.thresholds) {
    return colorScale.thresholds();
  }
  if (state.binMethod === "jenks") {
    const sorted = values.slice().sort(d3.ascending);
    const br = jenksBreaks(sorted, NUM_BINS);
    return br.slice(1, -1);
  }
  if (state.binMethod === "owidlog") {
    return (OWID_LOG_THRESHOLDS[state.metric] || OWID_LOG_THRESHOLDS.raw).slice();
  }
  return [];
}

function updateBinInfo() {
  const ct = document.getElementById("map-container");
  d3.select(ct).selectAll(".bin-info").remove();
  const txt = {
    quantile: "Quantile bins — equal country count per bin",
    jenks:    "Jenks natural breaks — minimize within-bin variance",
    equal:    "Equal-interval bins — even spacing across range",
    owidlog:  "OWID log bins — fixed 10^n thresholds (original map)",
  }[state.binMethod] || "";
  d3.select(ct).append("div").attr("class", "bin-info").text(txt);
}

// ---------------------------------------------------------------------------
// Ranked Country List
// ---------------------------------------------------------------------------
function updateRankedList() {
  const cv = state.currentCountryValues;
  const metric = state.metric;
  const query = state.searchQuery.toLowerCase();

  const rows = [];
  cv.forEach((entry) => {
    if (!entry || entry.value == null) return;
    rows.push(entry);
  });

  // Deduplicate by alpha3
  const seen = new Set();
  const unique = rows.filter(r => {
    if (seen.has(r.alpha3)) return false;
    seen.add(r.alpha3);
    return true;
  });

  unique.sort((a, b) => (b.value || 0) - (a.value || 0));

  const filtered = query
    ? unique.filter(r => r.name.toLowerCase().includes(query))
    : unique;

  // Bar length is anchored to the largest value in the CURRENT WEEK (after
  // dedup), so 100% = this week's leader. This gives immediate local
  // context; absolute-vs-historical is already shown by the circle size.
  const weekMax = unique.length ? (unique[0].value || 1) : 1;

  const titleEl = document.getElementById("panel-title");
  titleEl.textContent = `${filtered.length} Countries`;

  const sortEl = document.getElementById("panel-sort");
  sortEl.textContent = metric === "pm" ? "Per 100k ↓" : "Raw ↓";

  const list = document.getElementById("panel-list");
  let html = "";

  filtered.forEach((r, i) => {
    const rank = i + 1;
    const v = r.value || 0;
    const pct = v > 0 ? Math.min(100, (v / weekMax) * 100) : 0;
    const valStr = metric === "pm" ? fmt(r.value, 1) : fmt(r.value);
    const barColor = state.currentColorScale ? state.currentColorScale(v || 0.01) : "#444";
    const hl = state.highlightedCountry === r.alpha3 ? " highlighted" : "";

    html += `<div class="rank-row${hl}" data-a3="${r.alpha3}">
      <div class="rank-bar" style="width:${pct}%;background:${barColor}"></div>
      <span class="rank-num">${rank}</span>
      <span class="rank-name">${r.name}</span>
      <span class="rank-val">${valStr}</span>
    </div>`;
  });

  list.innerHTML = html;

  const footEl = document.getElementById("panel-foot");
  const total = unique.reduce((s, r) => s + (r.raw || 0), 0);
  footEl.textContent = `Total: ${fmt(total)} weekly cases`;

  list.querySelectorAll(".rank-row").forEach(row => {
    row.addEventListener("mouseenter", () => highlightCountry(row.dataset.a3));
    row.addEventListener("mouseleave", () => clearHighlight());
  });
}

// ---------------------------------------------------------------------------
// Linked Highlighting
// ---------------------------------------------------------------------------
function highlightCountry(alpha3) {
  state.highlightedCountry = alpha3;

  state.symbolLayer.selectAll("circle.symbol")
    .classed("highlighted", d => d && d.entry && d.entry.alpha3 === alpha3);

  document.querySelectorAll(".rank-row").forEach(row => {
    row.classList.toggle("highlighted", row.dataset.a3 === alpha3);
  });
}

function clearHighlight() {
  state.highlightedCountry = null;
  if (state.symbolLayer) {
    state.symbolLayer.selectAll("circle.symbol").classed("highlighted", false);
  }
  document.querySelectorAll(".rank-row.highlighted")
    .forEach(r => r.classList.remove("highlighted"));
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
function onSymbolHover(event, d) {
  const entry = d.entry;
  const tt = document.getElementById("tooltip");
  const active = state.metric === "pm" ? "pm" : "raw";

  tt.innerHTML = `
    <div class="country-name">${entry.name}</div>
    <div class="metric-row">
      <span class="metric-label">Per 100k:</span>
      <span class="metric-value ${active==='pm'?'primary':''}">${fmt(entry.pm, 1)}</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Weekly cases:</span>
      <span class="metric-value ${active==='raw'?'primary':''}">${fmt(entry.raw)}</span>
    </div>
    <div class="metric-row">
      <span class="metric-label">Population:</span>
      <span class="metric-value">${fmt(entry.pop)}</span>
    </div>`;

  highlightCountry(entry.alpha3);
  tt.classList.add("visible");
  positionTooltip(event);
}

function onSymbolMove(event) { positionTooltip(event); }

function onSymbolOut() {
  document.getElementById("tooltip").classList.remove("visible");
  clearHighlight();
}

function positionTooltip(event) {
  const tt = document.getElementById("tooltip");
  const pad = 14;
  let x = event.clientX + pad, y = event.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width  > window.innerWidth)  x = event.clientX - r.width  - pad;
  if (y + r.height > window.innerHeight) y = event.clientY - r.height - pad;
  tt.style.left = x + "px";
  tt.style.top  = y + "px";
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindControls() {
  document.getElementById("metric-toggle").addEventListener("click", e => {
    const btn = e.target.closest(".seg");
    if (!btn || btn.classList.contains("active")) return;
    state.metric = btn.dataset.value;
    activateSeg("metric-toggle", btn);
    updateMap();
  });

  document.getElementById("bin-toggle").addEventListener("click", e => {
    const btn = e.target.closest(".seg");
    if (!btn || btn.classList.contains("active")) return;
    state.binMethod = btn.dataset.value;
    activateSeg("bin-toggle", btn);
    updateMap();
  });

  document.getElementById("time-slider").addEventListener("input", e => {
    state.weekIndex = parseInt(e.target.value, 10);
    updateMap();
    updateDateDisplay();
  });

  document.getElementById("play-btn").addEventListener("click", togglePlay);

  document.getElementById("panel-search").addEventListener("input", e => {
    state.searchQuery = e.target.value;
    updateRankedList();
  });

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.code === "ArrowRight") { e.preventDefault(); stepWeek(1); }
    else if (e.code === "ArrowLeft")  { e.preventDefault(); stepWeek(-1); }
  });
}

function activateSeg(id, active) {
  document.querySelectorAll(`#${id} .seg`).forEach(b => b.classList.remove("active"));
  active.classList.add("active");
}

function updateDateDisplay() {
  const d = state.dates[state.weekIndex];
  document.getElementById("date-display").textContent = d ? d.display : "";
}

function togglePlay() {
  const btn = document.getElementById("play-btn");
  if (state.playing) {
    clearInterval(state.playInterval);
    state.playing = false;
    btn.classList.remove("playing");
  } else {
    state.playing = true;
    btn.classList.add("playing");
    state.playInterval = setInterval(() => {
      state.weekIndex = state.weekIndex >= state.dates.length - 1 ? 0 : state.weekIndex + 1;
      document.getElementById("time-slider").value = state.weekIndex;
      updateMap();
      updateDateDisplay();
    }, PLAY_SPEED_MS);
  }
}

function stepWeek(d) {
  const i = state.weekIndex + d;
  if (i < 0 || i >= state.dates.length) return;
  state.weekIndex = i;
  document.getElementById("time-slider").value = i;
  updateMap();
  updateDateDisplay();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function fmt(n, dec) {
  if (n == null) return "N/A";
  if (typeof dec === "number")
    return n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return Math.round(n).toLocaleString("en-US");
}

// Compact formatter for legend labels: 12,345 → "12.3K"
function fmtShort(n) {
  if (n == null) return "N/A";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  if (a >= 10)  return Math.round(n).toString();
  if (a >= 1)   return n.toFixed(1);
  return n.toFixed(2);
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", init);
