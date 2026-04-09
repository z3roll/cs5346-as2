#!/usr/bin/env python3
"""Preprocess OWID's weekly-covid-cases + Population CSV into the JSON schema
expected by `js/main.js`:

    {
      "dates": [{"key": "2020-W01", "display": "Dec 30, 2019"}, ...],
      "countries": {
        "USA": {"name": "United States", "pop": 331002651,
                 "weeks": {"2020-W01": {"r": 123, "p": 0.37}, ...}},
        ...
      }
    }

Input CSV: `weekly-covid-cases-with-population.csv` — already has aggregate
rows (Asia, World, EU, etc.) removed, with a Population column joined from
OWID's population dataset. Columns: Entity, Code, Day, Weekly cases, Population.

Per-capita unit: `p` is stored as **cases per 100,000 population**
(not per-million). Public-health-standard unit; produces more human-readable
magnitudes in tooltips and legends.

Sampling rule:
- OWID's "Weekly cases" column is a 7-day rolling sum ending on each day.
- For each ISO (year, week) we take the value on the Sunday of that week
  (last day of the ISO week) because Sunday's rolling-7 sum is exactly
  Monday-through-Sunday — the full ISO week.
- If Sunday is missing for a given entity we skip that week for that
  entity (don't fall back to any other day, because a non-Sunday rolling
  sum would span a different 7-day window and mislabel the week).
- The "display" field for each week is the SUNDAY date — i.e. the exact
  day in the CSV whose value is stored. This lets the user cross-check
  any value on the site against the raw CSV by date without confusion.
"""
from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_CSV = Path("/Users/zerol/Downloads/weekly-covid-cases-with-population.csv")
OUT_JSON = ROOT / "data" / "covid_weekly.json"


def iso_week_key(d: date) -> str:
    iy, iw, _ = d.isocalendar()
    return f"{iy}-W{iw:02d}"


def iso_week_sunday(iy: int, iw: int) -> date:
    # Sunday of ISO week (last day). Jan 4th is always in ISO week 1.
    jan4 = date(iy, 1, 4)
    _, _, jan4_idow = jan4.isocalendar()
    week1_monday = jan4 - timedelta(days=jan4_idow - 1)
    return week1_monday + timedelta(weeks=iw - 1, days=6)


def main() -> None:
    # Population is read directly from the CSV (last-seen value per code wins;
    # population rarely changes across the 2020-2026 window so this is safe).
    pop_by_a3: dict[str, int] = {}
    name_by_a3: dict[str, str] = {}

    # (a3, iso_day_key) -> weekly_cases
    # Only rows that fall on the Sunday of an ISO week are retained — that
    # is the only day whose rolling-7 sum spans a full Mon-Sun ISO week.
    by_day: dict[tuple[str, str], float] = {}
    all_weeks: set[str] = set()
    skipped_non_sunday = 0
    kept_sunday = 0

    with SRC_CSV.open() as f:
        rdr = csv.DictReader(f)
        for row in rdr:
            code = row["Code"]
            if not code or len(code) != 3:
                continue  # regional aggregates (already stripped, defensive)
            day_str = row["Day"]
            try:
                d = date.fromisoformat(day_str)
            except ValueError:
                continue

            # Capture population & name regardless of day — we want pop even
            # from non-Sunday rows so Pitcairn-style codes with no Sunday data
            # can still be filtered downstream by whether pop is set.
            pop_str = row.get("Population", "")
            if pop_str:
                try:
                    pop_by_a3[code] = int(pop_str)
                except ValueError:
                    pass
            name_by_a3[code] = row["Entity"]

            # Only keep Sundays (ISO weekday 7).
            if d.isoweekday() != 7:
                skipped_non_sunday += 1
                continue

            raw_str = row["Weekly cases"]
            try:
                raw = float(raw_str) if raw_str not in ("", None) else None
            except ValueError:
                raw = None
            if raw is None:
                continue

            all_weeks.add(iso_week_key(d))
            by_day[(code, day_str)] = raw
            kept_sunday += 1

    # Build sorted dates list — display = the Sunday date that the value
    # was sampled from, formatted as "Mon DD, YYYY". This matches the raw
    # CSV row exactly so users can cross-reference values.
    def wk_sort_key(wk: str) -> tuple[int, int]:
        y, w = wk.split("-W")
        return int(y), int(w)

    sorted_weeks = sorted(all_weeks, key=wk_sort_key)
    dates_out = []
    sun_by_wk: dict[str, str] = {}
    for wk in sorted_weeks:
        y, w = wk.split("-W")
        sun = iso_week_sunday(int(y), int(w))
        sun_str = sun.isoformat()
        sun_by_wk[wk] = sun_str
        dates_out.append({"key": wk, "display": sun.strftime("%b %d, %Y")})

    # Build countries
    countries_out: dict[str, dict] = {}
    skipped_no_pop: list[str] = []
    all_codes = sorted({c for (c, _) in by_day.keys()})
    for code in all_codes:
        pop = pop_by_a3.get(code)
        name = name_by_a3.get(code, code)
        if pop is None:
            # No population data (e.g. Pitcairn) — skip entirely. Symbol map
            # can't size a bubble without a denominator, and keeping r-only
            # rows would bias raw-count view.
            skipped_no_pop.append(code)
            continue
        weeks: dict[str, dict] = {}
        for wk in sorted_weeks:
            sun_str = sun_by_wk[wk]
            raw = by_day.get((code, sun_str))
            if raw is None:
                weeks[wk] = {"r": 0, "p": 0.0}
                continue
            r_out: float | int = int(raw) if raw == int(raw) else raw
            # per 100k (public-health standard unit)
            p = (raw / pop) * 100_000 if pop > 0 else 0.0
            weeks[wk] = {"r": r_out, "p": round(p, 2)}
        countries_out[code] = {
            "name": name,
            "pop": pop,
            "weeks": weeks,
        }

    payload = {"dates": dates_out, "countries": countries_out}
    OUT_JSON.write_text(json.dumps(payload, separators=(",", ":")))

    print(f"countries: {len(countries_out)}")
    print(f"weeks: {len(dates_out)}  ({sorted_weeks[0]} → {sorted_weeks[-1]})")
    print(f"Sunday rows kept: {kept_sunday}  |  non-Sunday rows skipped: {skipped_non_sunday}")
    print(f"unit: p = cases per 100,000 population")
    if skipped_no_pop:
        print(f"skipped (no population): {skipped_no_pop}")
    print(f"wrote {OUT_JSON} ({OUT_JSON.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
