/**
 * COVID-19 Choropleth Redesign — Dark "Mission Control" Theme
 *
 * Bias fixes:
 *   1. Per-capita default (cases per million)
 *   2. Equal Earth projection (area-preserving)
 *   3. Quantile-based dynamic color bins
 *
 * Features:
 *   - Interactive choropleth with time scrubbing
 *   - Ranked country list panel (right side) with live search
 *   - Linked highlighting between map and list
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  metric: "pm",
  binMethod: "quantile",
  weekIndex: 0,
  playing: false,
  playInterval: null,
  covidData: null,
  topoData: null,
  isoMapping: null,
  dates: [],
  geoFeatures: null,
  highlightedCountry: null,   // alpha3 code of hovered country
  searchQuery: "",
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NUM_BINS = 6;
const COLOR_PALETTE = d3.schemeYlOrRd[NUM_BINS + 1].slice(1);
const ZERO_COLOR = "#2a2518";   // dark warm tone for zero on dark bg
const PLAY_SPEED_MS = 200;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try {
    const [covidData, topoData, isoMapping] = await Promise.all([
      d3.json("data/covid_weekly.json"),
      d3.json("data/countries-110m.json"),
      d3.json("data/iso_mapping.json"),
    ]);

    state.covidData = covidData;
    state.topoData = topoData;
    state.isoMapping = isoMapping;
    state.dates = covidData.dates;

    // Build reverse mapping: numeric -> alpha3
    state.numericToAlpha3 = {};
    for (const [a3, num] of Object.entries(isoMapping)) {
      state.numericToAlpha3[num] = a3;
    }

    // Also build alpha3 -> numeric for list->map linking
    state.alpha3ToNumeric = {};
    for (const [a3, num] of Object.entries(isoMapping)) {
      state.alpha3ToNumeric[a3] = num;
    }

    state.geoFeatures = topojson.feature(
      topoData, topoData.objects.countries
    ).features;

    // Build a geoFeature lookup by numeric id for highlighting
    state.featureById = new Map();
    state.geoFeatures.forEach(f => {
      state.featureById.set(String(f.id).padStart(3, "0"), f);
    });

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

  const projection = d3.geoEqualEarth()
    .fitSize([w - 16, h - 16], { type: "Sphere" })
    .translate([w / 2, h / 2]);

  const path = d3.geoPath(projection);
  state.svg = svg; state.path = path; state.width = w; state.height = h;

  // Defs: no-data pattern (dark version)
  const defs = svg.append("defs");
  const pat = defs.append("pattern")
    .attr("id", "no-data-pattern")
    .attr("width", 6).attr("height", 6)
    .attr("patternUnits", "userSpaceOnUse")
    .attr("patternTransform", "rotate(45)");
  pat.append("rect").attr("width", 6).attr("height", 6).attr("fill", "#1a1e28");
  pat.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6)
    .attr("stroke", "#252a36").attr("stroke-width", 2);

  // Group all map geometry so zoom transforms the group, not individual paths
  const g = svg.append("g").attr("class", "map-g");

  // Sphere + graticule
  g.append("path").datum({ type: "Sphere" }).attr("class", "sphere").attr("d", path);
  g.append("path").datum(d3.geoGraticule10()).attr("class", "graticule").attr("d", path);

  // Countries
  g.selectAll(".country")
    .data(state.geoFeatures)
    .join("path")
    .attr("class", "country")
    .attr("d", path)
    .attr("data-id", d => String(d.id).padStart(3, "0"))
    .on("mouseover", onCountryHover)
    .on("mousemove", onCountryMove)
    .on("mouseout", onCountryOut);

  // Zoom/pan — lets users inspect small countries that are invisible at world scale
  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (event) => { g.attr("transform", event.transform); });
  svg.call(zoom);

  // Double-click to reset zoom
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
  const cv = new Map(); // id -> entry

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
  }

  const colorScale = buildColorScale(values, state.binMethod);

  state.mapGroup.selectAll(".country")
    .data(state.geoFeatures)
    .attr("fill", d => {
      const e = cv.get(d.id);
      if (!e) return "url(#no-data-pattern)";
      if (e.value == null || e.value === 0) return ZERO_COLOR;
      return colorScale(e.value);
    });

  state.currentCountryValues = cv;
  state.currentColorScale = colorScale;
  updateLegend(colorScale, values);
  updateBinInfo();
  updateRankedList();
}

// ---------------------------------------------------------------------------
// Color Scale
// ---------------------------------------------------------------------------
function buildColorScale(values, method) {
  if (!values.length) return () => ZERO_COLOR;
  values.sort(d3.ascending);
  return method === "quantile"
    ? d3.scaleQuantile().domain(values).range(COLOR_PALETTE)
    : d3.scaleQuantize().domain(d3.extent(values)).range(COLOR_PALETTE);
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function updateLegend(colorScale, values) {
  const ct = document.getElementById("map-container");
  d3.select(ct).selectAll(".legend-container").remove();

  const label = state.metric === "pm" ? "WEEKLY CASES / MILLION" : "WEEKLY CASES (RAW)";
  const leg = d3.select(ct).append("div").attr("class", "legend-container");
  leg.append("div").attr("class", "legend-title").text(label);
  const items = leg.append("div").attr("class", "legend-items");

  if (values.length) {
    let th = [];
    if (state.binMethod === "quantile" && colorScale.quantiles) th = colorScale.quantiles();
    else if (colorScale.thresholds) th = colorScale.thresholds();

    const brk = [d3.min(values), ...th, d3.max(values)];
    const bins = [];
    for (let i = 0; i < COLOR_PALETTE.length; i++) {
      const lo = i === 0 ? brk[0] : brk[i];
      const hi = i < brk.length - 1 ? brk[i + 1] : brk[brk.length - 1];
      bins.push({ color: COLOR_PALETTE[i], label: `${fmt(lo)} \u2013 ${fmt(hi)}` });
    }
    bins.reverse().forEach(b => {
      const it = items.append("div").attr("class", "legend-item");
      it.append("div").attr("class", "legend-swatch").style("background", b.color);
      it.append("span").attr("class", "legend-label").text(b.label);
    });
  }

  // Zero
  const z = items.append("div").attr("class", "legend-item");
  z.append("div").attr("class", "legend-swatch").style("background", ZERO_COLOR);
  z.append("span").attr("class", "legend-label").text("0 cases");

  // No data
  const nd = items.append("div").attr("class", "legend-item");
  nd.append("div").attr("class", "legend-swatch no-data-swatch");
  nd.append("span").attr("class", "legend-label").text("No data");
}

function updateBinInfo() {
  const ct = document.getElementById("map-container");
  d3.select(ct).selectAll(".bin-info").remove();
  const txt = state.binMethod === "quantile"
    ? "Quantile bins \u2014 equal count per bin"
    : "Equal-interval bins \u2014 even spacing";
  d3.select(ct).append("div").attr("class", "bin-info").text(txt);
}

// ---------------------------------------------------------------------------
// Ranked Country List (RIGHT PANEL)
// ---------------------------------------------------------------------------
function updateRankedList() {
  const cv = state.currentCountryValues;
  const metric = state.metric;
  const query = state.searchQuery.toLowerCase();

  // Collect all countries with data
  const rows = [];
  cv.forEach((entry, id) => {
    if (!entry || entry.value == null) return;
    rows.push(entry);
  });

  // Deduplicate by alpha3 (some countries may map to multiple geo features)
  const seen = new Set();
  const unique = rows.filter(r => {
    if (seen.has(r.alpha3)) return false;
    seen.add(r.alpha3);
    return true;
  });

  // Sort descending by value
  unique.sort((a, b) => (b.value || 0) - (a.value || 0));

  // Filter by search
  const filtered = query
    ? unique.filter(r => r.name.toLowerCase().includes(query))
    : unique;

  const maxVal = unique.length ? unique[0].value || 1 : 1;

  // Update panel title
  const titleEl = document.getElementById("panel-title");
  titleEl.textContent = `${filtered.length} Countries`;

  const sortEl = document.getElementById("panel-sort");
  sortEl.textContent = metric === "pm" ? "Cases/M \u2193" : "Raw cases \u2193";

  // Build list HTML (fast: innerHTML batch)
  const list = document.getElementById("panel-list");
  let html = "";

  filtered.forEach((r, i) => {
    const rank = i + 1;
    const pct = Math.min(100, ((r.value || 0) / maxVal) * 100);
    const valStr = metric === "pm" ? fmt(r.value, 1) : fmt(r.value);
    const barColor = state.currentColorScale ? state.currentColorScale(r.value || 0.1) : "#444";
    const hl = state.highlightedCountry === r.alpha3 ? " highlighted" : "";

    html += `<div class="rank-row${hl}" data-a3="${r.alpha3}">
      <span class="rank-num">${rank}</span>
      <span class="rank-name">${r.name}</span>
      <span class="rank-bar-wrap"><span class="rank-bar" style="width:${pct}%;background:${barColor}"></span></span>
      <span class="rank-val">${valStr}</span>
    </div>`;
  });

  list.innerHTML = html;

  // Footer
  const footEl = document.getElementById("panel-foot");
  const total = unique.reduce((s, r) => s + (r.raw || 0), 0);
  footEl.textContent = `Total: ${fmt(total)} weekly cases`;

  // Bind hover events on rows
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

  // Highlight on map
  const numId = state.alpha3ToNumeric[alpha3];
  state.mapGroup.selectAll(".country")
    .classed("highlighted", function() {
      return String(this.dataset.id) === numId;
    });

  // Highlight in list
  document.querySelectorAll(".rank-row").forEach(row => {
    row.classList.toggle("highlighted", row.dataset.a3 === alpha3);
  });
}

function clearHighlight() {
  state.highlightedCountry = null;
  state.mapGroup.selectAll(".country").classed("highlighted", false);
  document.querySelectorAll(".rank-row.highlighted").forEach(r => r.classList.remove("highlighted"));
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
function onCountryHover(event, d) {
  const entry = state.currentCountryValues.get(d.id);
  const tt = document.getElementById("tooltip");

  if (!entry) {
    const name = d.properties?.name || "Unknown";
    tt.innerHTML = `<div class="country-name">${name}</div>
                    <div style="color:var(--text-dim);font-size:.68rem">No data available</div>`;
  } else {
    const pm = state.metric === "pm" ? "pm" : "raw";
    tt.innerHTML = `
      <div class="country-name">${entry.name}</div>
      <div class="metric-row">
        <span class="metric-label">Cases / M:</span>
        <span class="metric-value ${pm==='pm'?'primary':''}">${fmt(entry.pm,1)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Raw cases:</span>
        <span class="metric-value ${pm==='raw'?'primary':''}">${fmt(entry.raw)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Population:</span>
        <span class="metric-value">${fmt(entry.pop)}</span>
      </div>`;
    // Also highlight in list
    highlightCountry(entry.alpha3);
  }

  tt.classList.add("visible");
  positionTooltip(event);
}

function onCountryMove(event) { positionTooltip(event); }

function onCountryOut() {
  document.getElementById("tooltip").classList.remove("visible");
  clearHighlight();
}

function positionTooltip(event) {
  const tt = document.getElementById("tooltip");
  const pad = 14;
  let x = event.clientX + pad, y = event.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (x + r.width > window.innerWidth) x = event.clientX - r.width - pad;
  if (y + r.height > window.innerHeight) y = event.clientY - r.height - pad;
  tt.style.left = x + "px";
  tt.style.top = y + "px";
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
function bindControls() {
  // Metric toggle
  document.getElementById("metric-toggle").addEventListener("click", e => {
    const btn = e.target.closest(".seg");
    if (!btn || btn.classList.contains("active")) return;
    state.metric = btn.dataset.value;
    activateSeg("metric-toggle", btn);
    updateMap();
  });

  // Bin toggle
  document.getElementById("bin-toggle").addEventListener("click", e => {
    const btn = e.target.closest(".seg");
    if (!btn || btn.classList.contains("active")) return;
    state.binMethod = btn.dataset.value;
    activateSeg("bin-toggle", btn);
    updateMap();
  });

  // Time slider
  document.getElementById("time-slider").addEventListener("input", e => {
    state.weekIndex = parseInt(e.target.value, 10);
    updateMap();
    updateDateDisplay();
  });

  // Play/Pause
  document.getElementById("play-btn").addEventListener("click", togglePlay);

  // Search in panel
  document.getElementById("panel-search").addEventListener("input", e => {
    state.searchQuery = e.target.value;
    updateRankedList();
  });

  // Keyboard
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

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", init);
