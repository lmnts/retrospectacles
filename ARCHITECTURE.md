# Retrospectacles — Architecture & Developer Reference

> A single-file career visualization dashboard for Vantagepoint (Deltek) timesheet data.  
> Everything lives in `retrospectacles.html`. No build step, no backend, no dependencies beyond a CDN-loaded Chart.js.

---

## Table of Contents

1. [What It Does](#1-what-it-does)
2. [Tech Stack & Constraints](#2-tech-stack--constraints)
3. [Data Model & Ingestion](#3-data-model--ingestion)
4. [Project Classification System](#4-project-classification-system)
5. [Application State](#5-application-state)
6. [Filter System (Sidebar)](#6-filter-system-sidebar)
7. [Views / Tabs](#7-views--tabs)
8. [Hover Interaction Architecture](#8-hover-interaction-architecture)
9. [Color & Theming System](#9-color--theming-system)
10. [Tooltip System](#10-tooltip-system)
11. [Export](#11-export)
12. [Key Design Decisions & Hard-Won Lessons](#12-key-design-decisions--hard-won-lessons)
13. [How to Recreate From Scratch](#13-how-to-recreate-from-scratch)

---

## 1. What It Does

Retrospectacles takes a JSON export of an employee's full timesheet history from Vantagepoint (Deltek) and turns it into six interactive career-data visualizations:

| Tab | View | Renderer |
|---|---|---|
| Overview | Annual heatmap + top-project bars | Canvas 2D |
| Monthly Mix | Stacked bar/area chart by project, monthly | Chart.js |
| Daily Mix | Per-day stacked bar chart | Canvas 2D |
| Grid | Project × time-period heatmap | Canvas 2D |
| Annual | Year-by-year billable vs. overhead | Chart.js |
| Career Arc | 5-bucket monthly stack + utilization line | Chart.js |

The Gantt view (`buildGantt`) is implemented but hidden from the nav by default.

Data is loaded either via drag-and-drop / file picker, or auto-loaded from an embedded JSON constant (`EMBEDDED_DATA`) at the bottom of the file for demo purposes.

---

## 2. Tech Stack & Constraints

- **Single HTML file** — everything (HTML, CSS, JS) is in `retrospectacles.html`. Intentional: it opens directly in a browser, is easy to share, and requires no deployment.
- **Chart.js 4.4.0** — loaded from CDN (`cdn.jsdelivr.net`). Used for Monthly Mix, Annual, and Career Arc only. All other charts are drawn via the raw Canvas 2D API.
- **No framework, no build** — vanilla JS ES2020. Relies on `Map`, `Set`, optional chaining (`?.`), template literals, `Array.from`, etc.
- **Dark mode** — implemented via CSS custom properties (`--paper`, `--b0`…`--b9`, `--cyan`, etc.) swapped on `body.dark`. Both light and dark palettes defined as JS objects (`CL` / `CD`) so chart colors can be updated at runtime.
- **Flexbox layout** — the shell is `height:100%; overflow:hidden` with a flexbox column. Each pane fills available space. Charts use `responsive:true, maintainAspectRatio:false` in Chart.js or manually compute their canvas `width/height`.

---

## 3. Data Model & Ingestion

### Raw JSON Format

The file expects the JSON produced by `extract.js` / the bookmarklet (see `EXTRACTION_GUIDE.md`). Top-level shape:

```json
{
  "name": "Alex Woodhouse",
  "01/01/2024 - 01/14/2024": {
    "rows": [
      {
        "project": "12345",
        "projectName": "Main Street Library",
        "client": "City of Springfield",
        "phase": "20",
        "phaseName": "Design Development",
        "task": "210",
        "dailyHours": {
          "Mon 1/1": "8.0",
          "Tue 1/2": "7.5"
        }
      }
    ]
  }
}
```

Key fields:
- Period labels like `"01/01/2024 - 01/14/2024"` supply the year (`sy = parseInt(sp[2])`). The day/month headers inside `dailyHours` only carry `M/D` so the year comes from the period key.
- `project` is the Vantagepoint project **code** — either a 5-digit billable code (`12345`), an overhead pattern (`24TEC`, `23BD-1`), or a personal code (`PTO`, `Reg Holiday`, `Flex Holiday`, `Sick`, etc.).

### `processData(raw)` — Line ~702

Converts raw JSON → structured state. Key operations:

1. **Iterate periods → rows → daily hours.** For each `row`, compute a composite key: `` `${row.project}||${row.phase||''}||${row.task||''}` `` so multiple phases of the same project are tracked separately.
2. **Classify** each project code (see §4).
3. **Normalize holiday names** — `"Reg Holiday"` and `"Flex Holiday"` are normalized to `"Holiday"` in `projectName` at ingest time:
   ```js
   const n = (row.projectName||row.project).replace(/^z_/,'');
   return /^(reg(ular)?\s+holiday|flex\s+holiday)$/i.test(n.trim()) ? 'Holiday' : n;
   ```
4. **Build parallel indexes**: `daily` (`Map<ISO-date, Map<key, hours>>`), `monthly` (`Map<YYYY-MM, Map<key, hours>>`), `entries` array (flat sorted list).
5. **Date guards** — skip entries whose reconstructed year is `< 1985` or `> 2040`. This prevents runaway loops from pre-Deltek historical imports or pagination edge-case data.
6. **Gap year detection** — years with zero billable hours are treated as employment gaps. Their entries are removed, and non-billable entries in the return year before the first billable month are also trimmed. This keeps the Overview heatmap from showing a ghost column.
7. **Brand color heuristics** (`applyBrandColors`) — matches project/client names against known university and tech-client patterns to pre-assign thematic colors (e.g., Iowa gold, UW purple, Amazon orange).

Returns a state object merged into `S` via `Object.assign`.

---

## 4. Project Classification System

This is the most critical and most complex part of the app. Understanding it is essential for re-creation.

### `classify(projectCode)` — Line ~496

A project code is classified into one of three categories:

| Rule | Category |
|---|---|
| Starts with 5 digits (`^\d{5}`) | `'billable'` |
| Matches `PTO\|Sick\|Reg Holiday\|Flex Holiday\|Cont Educ\|Huddle` | `'personal'` |
| Everything else | `'overhead'` |

`'personal'` entries (PTO, holidays, huddles) are excluded from utilization denominators and from the Overview heatmap.

### `getGroupKey(meta)` — Line ~554

Maps a project's metadata to a canonical **group key** used for aggregation and coloring:

| Code pattern | Group key | Example |
|---|---|---|
| `\d{2}[A-Z]{2,6}-?\d*` | `OV:XXXX` | `24TEC` → `OV:TEC` |
| Client = Microsoft | `CL:Microsoft` | |
| Client = Amazon | `CL:Amazon` | |
| Client = Google | `CL:Google` | |
| `\d{5}-\d+` (phase-suffixed) | `PJ:NNNNN` | `12345-20` → `PJ:12345` |
| Anything else | `PJ:<code>` | `PTO` → `PJ:PTO` |

### `mixGroupKey(meta)` — Line ~588

Used by Monthly Mix and Daily Mix to further consolidate overhead into semantic buckets. Takes `meta` (the full project metadata object) and returns one of the special constants or the raw group key:

| Constant | Label | Meaning |
|---|---|---|
| `OV:TEC` | Tech Studio | Passes through unchanged |
| `OV_PTO_GK = 'OV:__PTO'` | Holiday / PTO | All PTO, holiday, sick leave |
| `OV_PURSUIT_GK = 'OV:__PURSUIT'` | Pursuits & BD | Proposals, RFPs, business development |
| `OV_MKTG_GK = 'OV:__MKTG'` | Marketing | Comms, photography, portfolio, website |
| `OV_STUDIOS_GK = 'OV:__STUDIOS'` | Studio Overhead | All other internal overhead |

**PTO routing is applied to all non-billable projects**, not just `OV:`-coded ones. This catches `PJ:Reg Holiday` and similar codes that bypass the overhead code pattern. The check runs before the `OV:` gate:
```js
if (meta.category === 'personal' && (nm.includes('holiday') || nm.includes('pto') || ...))
  return OV_PTO_GK;
```

Helper functions `_isPursuit(nm, gk)` and `_isMktg(nm, gk)` contain extensive keyword lists used to identify pursuit/BD and marketing overhead by name.

### `getGroupInfo(gk)` — Line ~648

Resolves a group key to `{ name, color, isBillable, client }`. Handles:
- Special constants (`OV:__PTO` etc.)
- `OV:` prefixed overhead codes
- `CL:` client-based keys
- `PJ:NNNNN` — looks up project by exact code, or by base number (strips phase suffixes)

---

## 5. Application State

Two global objects:

```js
let S = {
  entries: [],           // flat sorted array of {date, key, hours}
  personName: '',
  projectMeta: Map,      // key → {project, projectName, client, phase, phaseName,
                         //        task, category, isBillable, color, totalHours,
                         //        firstDate, lastDate}
  dailyMap: Map,         // ISO-date → Map<key, hours>
  dailyTotals: Map,      // ISO-date → total hours
  monthMap: Map,         // YYYY-MM → Map<key, hours>
  projectList: [],       // array of composite keys with totalHours > 0
  minDate: '',           // ISO date string
  maxDate: '',
  totalHours: 0,
  billableHours: 0,
  charts: {}             // {arc, monthly, annual} — Chart.js instances
};

const F = {
  cat: 'all',            // 'all' | 'billable' | 'overhead'
  projects: Set,         // selected project codes (empty = all)
  phases: Set,           // selected phase codes (empty = all)
  yearMin: 0,
  yearMax: 9999
};
```

`renderActive()` is the single re-render entry point. It calls the appropriate `build*()` function for the active tab. Filter changes call `onFC()` → `getFiltered()` → `renderActive()`.

---

## 6. Filter System (Sidebar)

The collapsible left sidebar (222px wide by default, resizable via drag) contains:

- **Category pills** — All / Billable / Overhead
- **Year range** — min/max year selectors (populated from actual data range)
- **Project list** — checkboxes grouped by Billable / Overhead / Personal, with color swatches (clickable to invoke the color picker), sorted by total hours within each group. Supports live search.
- **Phase list** — checkboxes filtered to phases appearing in currently-selected projects

`getFiltered()` applies all active filters in one pass over `S.entries`. When no filters are active it returns `S.entries` directly (reference equality check used in `onFC` to detect filtered state).

The sidebar is resizable on desktop (drag handle at right edge); on mobile it collapses to 38px and expands as an overlay.

---

## 7. Views / Tabs

### Overview (`buildOv`, `buildHeatmap`, `buildProjBars`)

- Left panel: 12×N month/year heatmap drawn on a raw canvas. Cell size auto-fits the available container.
- Two display modes toggled by a button: **intensity mode** (cyan gradient by hours density) and **project overlay mode** (stacked horizontal color bands showing dominant projects).
- Right panel: horizontal bar chart of top 40 projects by hours (pure DOM, not canvas).
- Divider between panels is draggable; resize triggers `buildHeatmap()` via `ResizeObserver`.
- Deferred with `requestAnimationFrame` to ensure the pane's CSS layout has been applied before reading `clientWidth`.

### Monthly Mix (`buildMix`)

**Chart.js stacked bar or area chart** showing one bar per month, colored by project group key.

- Top N projects (selectable: 12, 20, 50, All) sorted by first appearance chronologically for stable stacking order.
- Remaining projects merged into "Other" (`C.b3`).
- Year boundary lines drawn as a custom `afterDraw` plugin (`mixYearLines`).
- Hover dimming drawn as a second `afterDraw` plugin (`mixDim`) — draws a semi-transparent overlay over all non-hovered datasets.
- Mouse detection uses fractional y-position arithmetic (see §8).
- External tooltip shows month total and per-project breakdown.

### Daily Mix (`buildDaily`)

**Raw canvas 2D** — not Chart.js. Each day is one thin vertical column, pixel-width calculated as `container.clientWidth / totalDays` for the fit view. Zoom multiplies this.

- Autoscales: `scale = (MAX_H * 0.9) / maxDayTotal` so the busiest day fills 90% of the fixed `MAX_H = 300px` height.
- Dynamic y-axis ticks: step size adapts to `maxH` range; 8h line is always rendered (bold, solid orange) regardless of tick step.
- Weekend days get a light background tint.
- **8h hover mode**: when cursor is within a few pixels of the 8h line, a secondary hover state activates — sub-8h zone is screened back, the 8h line is redrawn sharp in full opacity.
- Stats panel shows: avg hours/active week, total OT hours (M–F >8h + all weekend hours), peak 2-week and 3-week rolling windows, and top 3 peak weeks.

### Grid (`buildGrid`)

**Raw canvas 2D** heatmap. Projects on rows, time buckets (month/week/day) on columns. Color intensity interpolates between `C.b1` (background) and the project's color.

- Must be deferred with `requestAnimationFrame` in `renderActive` — the pane transitions from `display:none` and needs a reflow before `container.clientWidth` is accurate.

### Annual (`buildAnnual`)

**Chart.js stacked bar**. Billable (cyan) vs. overhead (gray) per year. Utilization percentage is drawn inside the billable bar segment via a custom `afterDatasetsDraw` plugin.

### Career Arc (`buildArc`)

**Chart.js mixed chart** — stacked bar (5 datasets) + line overlay on a secondary axis.

Five buckets:
| Key | Label | Color |
|---|---|---|
| `bill` | Billable | `C.b3` (gray-brown) |
| `tec` | Tech Studio | `C.green` |
| `pur` | Pursuits & BD | `C.purple` |
| `ov` | Studio Overhead | `C.orange` |
| `pto` | PTO / Holiday | `C.blue` |

The utilization line (3-month centered rolling average) is drawn as a line dataset on a right-side `pct` axis (0–100%).

Custom legend below the chart uses HTML `<span>` elements with `mouseenter/mouseleave` for hover interactions.

**Overlay plugin** (`arcDim`): after datasets are drawn, if `chart._hovDsi !== null`, iterates all non-hovered datasets and draws a semi-transparent fill over each bar. Then explicitly re-draws the utilization line and tooltip on top.

### Gantt (`buildGantt`)

Implemented, hidden from nav. Raw canvas 2D. One row per project, one horizontal bar spanning first → last active date. Has frozen header row and frozen left column drawn on overlay canvases that are repositioned on scroll.

---

## 8. Hover Interaction Architecture

This was the hardest problem to get right. There were two failed approaches before the current solution:

### ❌ Approach 1: `barEl.y / barEl.base` from `getDatasetMeta`

Chart.js exposes bar element coordinates via `chart.getDatasetMeta(i).data[j].y` and `.base`. These are in the chart's *internal* pixel space, which does **not** match CSS pixels from `getBoundingClientRect()` at non-1× display scale or when the canvas has been resized. Hover hit-testing with these values reliably fails.

### ❌ Approach 2: `scale.getPixelForValue(cumulativeValue)`

Calling `chart.scales.y.getPixelForValue(cum)` to find the pixel Y for each segment boundary. Also breaks at non-1× DPR and when chart layout hasn't stabilized.

### ✓ Current Approach: Fractional Y-arithmetic

Convert the cursor's CSS-pixel Y coordinate into a **fraction of the chart area height**, then multiply by `chart.scales.y.max` to get the "hours at cursor". Walk the cumulative stack to find which segment contains that value:

```js
const yMax = chart.scales.y.max || 1;
const yFrac = Math.max(0, Math.min(1, (ca.bottom - cy) / (ca.bottom - ca.top)));
const hoursAtCursor = yFrac * yMax;
let cum = 0, hovDsi = null;
for (let i = 0; i < ARC_DS.length; i++) {
  const val = mData[mo]?.[ARC_DS[i].key] || 0;
  if (!val) continue;
  if (hoursAtCursor >= cum && hoursAtCursor <= cum + val) { hovDsi = i; break; }
  cum += val;
}
```

`ca` is `chart.chartArea` (CSS pixels, always correct). `cy` is `e.clientY - canvas.getBoundingClientRect().top`. No scale pixel conversion needed.

### `afterDraw` Overlay Plugin

Dimming non-hovered segments is done in a Chart.js `afterDraw` plugin (runs after all datasets are painted). It reads a custom property set directly on the chart instance (`chart._hovDsi` for Career Arc, `chart._hovGk` for Monthly Mix) and draws semi-transparent overlays over non-hovered bars.

To trigger a repaint without a data update: `chart.draw()` (not `chart.update('none')` — the latter can trigger more lifecycle events than needed).

### Career Arc: Line + Tooltip Above Overlay

The `arcDim` plugin must explicitly re-draw the utilization line and tooltip on top of the dim overlay:
```js
try { chart.getDatasetMeta(ARC_DS.length).controller.draw(); } catch(e) {}
try { if (chart.tooltip) chart.tooltip.draw(chart.ctx); } catch(e) {}
```

### Daily Mix: Canvas 2D with DPR correction

The Daily Mix canvas does not use Chart.js. The hover implementation must account for the CSS-pixel ↔ canvas-pixel conversion:
```js
const rect = canvas.getBoundingClientRect();
const scaleX = canvas.width / rect.width;
// then multiply all coordinates by scaleX before hit-testing
```

### 8h Hover Mode (Daily Mix)

A sentinel value `'__8h'` is stored in `canvas._dailyHoverGk`. `_drawDailyFrame(hoverGk)` checks for this value first. When active:
- The sub-8h zone gets a white overlay at 35% opacity
- The 8h line is redrawn at full `C.orange` opacity
- All bars above 8h remain at full opacity

---

## 9. Color & Theming System

### CSS Custom Properties

Defined in `:root` and `body.dark`. Named after the Flexoki palette:
- `--paper` — page background
- `--b0` through `--b9` — neutral scale (light background → near-black text in light mode; inverted in dark)
- `--cyan`, `--blue`, `--orange`, `--green`, `--yellow`, `--red`, `--purple`, `--mag` — accent colors

### JS Color Objects

`CL` (light) and `CD` (dark) mirror the CSS custom properties for use in canvas drawing. `C` is a live shallow copy: `let C = Object.assign({}, CL)`. `applyDark(dark)` updates `C` in place and destroys/rebuilds all charts.

### Project Color Assignment

`pc(key)` — deterministic color from project key:
1. If the project code is a known personal category (`PTO`, `Sick`, etc.), return a fixed color from the `OV` map.
2. Otherwise, hash the project code string to an index into the 20-color `PAL` / `PAL_D` arrays.

The hash is stable — same project always gets the same color across sessions.

### User-Overridable Colors

`customColors` object (keyed by group key). Color picker: clicking a swatch in the sidebar or legend opens a hidden `<input type="color">`. On change, the new color is stored in `customColors[gk]`, all charts are destroyed, and `renderActive()` rebuilds everything.

`defaultColors` holds brand-matched heuristic colors (applied after data load). `customColors` takes priority over `defaultColors`, which takes priority over `pc()`.

---

## 10. Tooltip System

A single `<div id="tip">` floats absolutely over the page, shown/hidden by `showTip(src, html)` and `hideTip()`.

`showTip` positions the tooltip at cursor + (14px, 14px), clamped to viewport edges, flipping above the cursor if it would overflow the bottom.

The tooltip uses its own small CSS classes:
- `.td` — title row (date or project name)
- `.tr` — data row with flex layout
- `.tc` — small colored dot
- `.th` — right-aligned number

Monthly Mix uses Chart.js's `external` tooltip callback (`externalMixTip`) which re-routes Chart.js's tooltip data to `showTip`. Other charts call `showTip` directly from their `onmousemove` handlers.

---

## 11. Export

`exportCSV()` — exports the current filtered view as a CSV file download with columns:
`date, project_code, project_name, client, phase_code, phase_name, task_code, group_key, category, hours`

The download uses a `Blob` + temporary anchor element.

---

## 12. Key Design Decisions & Hard-Won Lessons

### Single File
All HTML, CSS, JS, and embedded demo data in one file. This is a strict requirement — not an oversight. Makes it trivially shareable (`File > Share`), works offline, and requires zero tooling.

### Chart.js Only for Multi-Dataset Line/Bar
Chart.js is used when you need:
- Built-in scale/axis management
- Mixed chart types (Career Arc: bar + line on dual axes)
- Responsive canvas sizing with correct DPR handling

Raw Canvas 2D is used when you need:
- Precise control over pixel-level layout (heatmaps, Gantt)
- Non-standard interactions (8h line hover, day-level drill-down)
- Performance (Daily Mix draws thousands of columns)

### `requestAnimationFrame` for Grid/Overview
Both `buildOv` and `buildGrid` are wrapped in `requestAnimationFrame`. Without this, `container.clientWidth` returns 0 when switching to a tab that was previously `display:none` — the browser hasn't reflowed yet.

### DST-Safe Week Iteration
When iterating weeks, always use `date.setDate(date.getDate() + 7)` — never `timestamp + 7 * 24 * 3600 * 1000`. The latter drifts across DST transitions.

### Year Sourced from Period Label, Not Date Header
Vantagepoint's day headers inside `dailyHours` are `"Mon 1/1"` — no year. The year is extracted from the period label key (e.g., `"01/01/2024 - 01/14/2024"`). Code: `const sp = lbl.split(' - ')[0].split('/'); const sy = parseInt(sp[2]);`

### Personal Time vs. Overhead
`classify()` distinguishes three categories. "Personal" (PTO, holidays) is excluded from utilization calculations. The utilization formula is:
```
utilization = billableHours / (billableHours + overheadHours)
// personal hours are excluded from denominator
```

### Holiday Code Normalization
Vantagepoint uses separate project codes for `PTO`, `Reg Holiday`, `Flex Holiday`, `Sick`, etc. These don't follow the overhead code pattern (`\d{2}[A-Z]+`) so `getGroupKey` returns `PJ:Reg Holiday` instead of an `OV:` key. Fix: apply the PTO name-check in `mixGroupKey` to ALL projects whose `meta.category === 'personal'`, not only `OV:`-coded ones.

### Chart Destruction on Dark Mode Toggle
When dark mode changes, all Chart.js instances in `S.charts` are destroyed and rebuilt. This is the cleanest way to propagate new colors to Chart.js internals (axis ticks, grid lines, tooltips) which don't support live color updates.

### Stable Project Color Across Filter States
Colors are assigned by `pc(key)` which hashes the project code string. Because the hash is deterministic and uses the palette modulo index, the same project always gets the same color regardless of which other projects are visible or what order they're sorted in.

---

## 13. How to Recreate From Scratch

A step-by-step guide to rebuilding this app.

### Step 1: Shell & Layout

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    /* CSS custom properties for light/dark theming */
    :root { --paper: #fffcf0; /* ... Flexoki palette ... */ }
    body.dark { --paper: #100f0f; /* ... dark variants ... */ }
  </style>
</head>
<body>
  <!-- Fixed header with stats pills -->
  <!-- Horizontal tab nav -->
  <!-- Sidebar (collapsible, resizable) + content area -->
  <!-- Pane per tab (display:none / display:flex .on) -->
  <!-- Floating tooltip div -->
  <script>...</script>
</body>
```

CSS structure:
- `body { display:flex; flex-direction:column; height:100%; overflow:hidden }`
- `#main-wrap { flex:1; display:flex; overflow:hidden }` — sidebar + content
- `.pane { display:none }` / `.pane.on { display:flex; flex-direction:column }`
- Chart canvases inside `<div style="flex:1;min-height:0">` so they stretch to fill

### Step 2: Color System

Define `CL` and `CD` objects in JS with the same keys as CSS custom properties. `let C = Object.assign({}, CL)`. In `applyDark(dark)`, swap `C`'s values from the appropriate object and toggle `body.dark`.

Use `PAL` (light) and `PAL_D` (dark) as 20-color arrays for project color assignment. The `pc(key)` hash function maps any string → palette index.

### Step 3: Data Ingestion (`processData`)

Build these in order:
1. Parse period label → extract 4-digit year from `"M/D/YYYY"` string
2. Per row: compute composite key = `project||phase||task`
3. Apply `classify(project)` to get category
4. Normalize holiday project names
5. Accumulate into `entries[]`, `daily` Map, `monthly` Map, `meta` Map
6. Apply date guards (skip year < 1985 or > 2040)
7. Gap year detection and trimming
8. Sort entries by date

### Step 4: Classification Pipeline

Implement in this order (they depend on each other):
1. `classify(code)` — three-way billable/personal/overhead
2. `getGroupKey(meta)` — overhead code regex, client patterns, phase-suffix stripping
3. `_isPursuit(nm, gk)` and `_isMktg(nm, gk)` — keyword lists
4. `mixGroupKey(meta)` — collapse to 5 buckets; PTO check must run before OV: gate
5. `getGroupInfo(gk)` — resolve group key to `{name, color, isBillable, client}`

### Step 5: Filter System

```js
const F = { cat: 'all', projects: new Set(), phases: new Set(), yearMin: 0, yearMax: 9999 };
function getFiltered() { /* single-pass filter over S.entries */ }
function onFC() { /* recompute stats, re-render active tab */ }
```

Sidebar HTML: category pills, year dropdowns, project list (grouped + searchable), phase list.

### Step 6: Tooltip

Single floating `<div id="tip">`. `showTip(src, html)` — position at cursor, clamp to viewport. `hideTip()`. All hover handlers call these.

```css
#tip {
  position: fixed; z-index: 9999;
  background: var(--paper); border: 1px solid var(--b2);
  border-radius: 8px; padding: 8px 10px; pointer-events: none;
  box-shadow: var(--sh2); max-width: 320px; display: none;
}
```

### Step 7: Implement Views — Easiest to Hardest

1. **Annual** (Chart.js stacked bar — 20 lines of config)
2. **Overview heatmap** (raw canvas, nested loop over years × months)
3. **Project bars** (pure DOM/innerHTML)
4. **Grid** (raw canvas, 2D lookup table)
5. **Monthly Mix** (Chart.js + `afterDraw` dim plugin + fractional Y hover)
6. **Career Arc** (Chart.js mixed + `afterDraw` dim + line re-draw + legend)
7. **Daily Mix** (raw canvas + 8h line + secondary hover mode + stats panel)

### Step 8: Hover Highlight Pattern

For each Chart.js chart that needs hover highlighting:

```js
// 1. Store hover state on chart instance
chart._hovXxx = null;

// 2. afterDraw plugin reads it and draws overlays
plugins: [{
  id: 'dimPlugin',
  afterDraw(chart) {
    const hov = chart._hovXxx;
    if (hov == null) return;
    const ctx2 = chart.ctx, ca = chart.chartArea;
    ctx2.save();
    // iterate non-hovered datasets, draw overlay rects
    ctx2.restore();
    // re-draw any overlaid line/tooltip
  }
}]

// 3. Mouse handler uses fractional Y arithmetic
canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const ca = chart.chartArea;
  if (cx < ca.left || cx > ca.right || cy < ca.top || cy > ca.bottom) {
    chart._hovXxx = null; chart.draw(); return;
  }
  const yFrac = Math.max(0, Math.min(1, (ca.bottom - cy) / (ca.bottom - ca.top)));
  const hoursAtCursor = yFrac * (chart.scales.y.max || 1);
  // walk cumulative stack to find hovered segment
  chart._hovXxx = result;
  chart.draw(); // not chart.update()
});
```

### Step 9: Color Picker

```js
let _cpInput = null;
function pickColorByGk(gk) {
  if (!_cpInput) {
    _cpInput = document.createElement('input');
    _cpInput.type = 'color';
    _cpInput.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:0;height:0';
    document.body.appendChild(_cpInput);
  }
  _cpInput.value = (customColors[gk] || getGroupInfo(gk).color || '#888').slice(0, 7);
  _cpInput.oninput = _cpInput.onchange = () => {
    customColors[gk] = _cpInput.value;
    // destroy all charts and re-render
  };
  _cpInput.click();
}
```

### Step 10: Embedded Demo Data

At the very bottom of the JS, define `const EMBEDDED_DATA = { ... }` with a representative sample of real or synthetic data. Then:

```js
Object.assign(S, processData(EMBEDDED_DATA));
initApp();
```

This makes the file open-and-work with no uploads required, which is essential for demos and sharing.

---

## File Structure (All in One File)

```
retrospectacles.html
│
├── <head>
│   ├── Chart.js CDN script tag
│   └── <style> — all CSS (~450 lines)
│       ├── CSS custom properties (light + dark)
│       ├── Reset + body/flex layout
│       ├── Header, nav tabs, sidebar
│       ├── Panes, boxes, controls
│       ├── Project bars, buttons
│       └── Tooltip
│
└── <body>
    ├── #app (flex column)
    │   ├── #hdr — logo, stats pills, dark toggle
    │   ├── #nav-bar — tab buttons
    │   └── #main-wrap (flex row)
    │       ├── #sidebar — filters
    │       └── #content-area
    │           ├── #nav-bar (tab strip)
    │           └── #pane-wrap
    │               ├── #pane-overview
    │               ├── #pane-mix
    │               ├── #pane-daily
    │               ├── #pane-grid
    │               ├── #pane-annual
    │               └── #pane-careerarc
    ├── #tip — floating tooltip
    └── <script> — all JS (~1800 lines)
        ├── Color palettes (CL, CD, PAL, PAL_D)
        ├── Dark mode (applyDark)
        ├── Project classification (classify, getGroupKey, mixGroupKey, etc.)
        ├── Color assignment (pc, customColors, defaultColors, applyBrandColors)
        ├── State (S, F)
        ├── processData
        ├── getFiltered, aggregateByGroup
        ├── File load + drag-drop handlers
        ├── initApp, switchTab, renderActive
        ├── buildOv (heatmap + project bars)
        ├── buildAnnual
        ├── buildArc (Career Arc)
        ├── updateChartNote
        ├── buildMixLegend, pickColorByGk
        ├── buildMix (Monthly Mix)
        ├── externalMixTip
        ├── buildGantt
        ├── buildGrid
        ├── buildDaily
        ├── pickColor
        ├── exportCSV
        ├── showTip, hideTip
        └── EMBEDDED_DATA + init
```

---

*Last updated: April 2026. Commit history: `git log --oneline` in this repo.*
