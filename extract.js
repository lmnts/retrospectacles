/**
 * Deltek Vantagepoint Timekeeper — Timesheet Data Extractor
 * ==========================================================
 * Version: 1.0.0
 *
 * PURPOSE
 * -------
 * This script is designed to run as a bookmarklet inside the user's browser
 * while they are logged into Deltek Vantagepoint Timekeeper. It navigates
 * backwards through all available pay periods, scrapes the timesheet data
 * for each one, and downloads the result as a single JSON file that can be
 * loaded into the Retrospectacles timesheet visualizer.
 *
 * HOW IT WORKS
 * ------------
 * 1. The user clicks the bookmarklet while on the Timekeeper page.
 * 2. A floating progress panel appears in the top-right corner.
 * 3. The script reads the employee code from the current URL hash and begins
 *    navigating backward through pay periods by changing location.hash.
 * 4. For each period it waits for the page to render, then reads the table
 *    of project rows and daily hours from the DOM.
 * 5. When all historical data has been collected (or the user clicks Stop),
 *    the data is serialized to JSON and downloaded.
 *
 * OUTPUT FORMAT
 * -------------
 * {
 *   "name": "Jane Smith",
 *   "1/5/2026 - 1/18/2026": {
 *     "period": "1/5/2026 - 1/18/2026",
 *     "dateHeaders": ["Mon 1/5", "Tue 1/6", ...],
 *     "rows": [
 *       {
 *         "project": "22059-01",
 *         "projectName": "UD - Carkeek Park Ped Bridge Replacement",
 *         "client": "Seattle Parks and Recreation",
 *         "phase": "01",
 *         "phaseName": "",
 *         "task": "",
 *         "dailyHours": { "Mon 1/5": 8, "Tue 1/6": 4 }
 *       }
 *     ]
 *   }
 * }
 *
 * SECURITY NOTE FOR IT REVIEWERS
 * --------------------------------
 * This script:
 *   - Makes no network requests to any external server.
 *   - Only reads data that is already displayed on the page the user is viewing.
 *   - Stores nothing in localStorage, sessionStorage, or cookies.
 *   - Triggers a local file download only — data never leaves the user's machine.
 *   - Contains no obfuscation. All logic is plain, readable JavaScript.
 *
 * COMPATIBILITY
 * -------------
 * Requires a modern browser (Chrome 90+, Edge 90+, Firefox 88+).
 * Tested against Vantagepoint versions that use the hash-based URL pattern:
 *   #!Timekeeper/view/0/0/{EMPLOYEE_CODE}%7C{YYYY-MM-DD}%7C%20/presentation
 */

(function () {
  'use strict';

  // ─── Guard: prevent duplicate runs ───────────────────────────────────────────
  if (window.__timesheetExtractorRunning) {
    alert('Timesheet extractor is already running. Check the panel in the top-right corner.');
    return;
  }
  window.__timesheetExtractorRunning = true;

  // ─── Guard: must be on the Timekeeper page ────────────────────────────────────
  const href = window.location.href;
  const hash = window.location.hash;
  if (!href.includes('Timekeeper') && !hash.includes('Timekeeper')) {
    alert(
      'This bookmarklet must be run on the Vantagepoint Timekeeper page.\n\n' +
      'Please navigate to Timekeeper and try again.'
    );
    window.__timesheetExtractorRunning = false;
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 1 — UTILITY HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Format a Date as "M/D/YYYY" with no leading zeros (e.g. "1/5/2026").
   * @param {Date} d
   * @returns {string}
   */
  function formatDate(d) {
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }

  /**
   * Format a Date as "YYYY-MM-DD" for use in Vantagepoint URLs.
   * @param {Date} d
   * @returns {string}
   */
  function formatDateISO(d) {
    const yyyy = d.getFullYear();
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  /**
   * Parse a date string in "M/D/YYYY" or "YYYY-MM-DD" format into a Date.
   * Returns null if the string cannot be parsed.
   * @param {string} s
   * @returns {Date|null}
   */
  function parseDate(s) {
    if (!s) return null;
    s = s.trim();
    // ISO format: YYYY-MM-DD
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);
    // Localized format: M/D/YYYY
    const loc = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (loc) return new Date(+loc[3], +loc[1] - 1, +loc[2]);
    return null;
  }

  /**
   * Return a new Date that is `n` days before `d`.
   * @param {Date} d
   * @param {number} n
   * @returns {Date}
   */
  function subtractDays(d, n) {
    const copy = new Date(d.getTime());
    copy.setDate(copy.getDate() - n);
    return copy;
  }

  /**
   * Resolve the innerText of an element, falling back to value (for inputs).
   * @param {Element} el
   * @returns {string}
   */
  function getText(el) {
    if (!el) return '';
    return (el.tagName === 'INPUT' ? el.value : el.innerText || el.textContent || '').trim();
  }

  /**
   * Wait up to `timeout` ms for `predicate()` to return a truthy value,
   * polling every `interval` ms.
   * @param {Function} predicate
   * @param {number} timeout   milliseconds
   * @param {number} interval  milliseconds
   * @returns {Promise<any>}  resolves with the truthy value, or null on timeout
   */
  function waitFor(predicate, timeout = 4000, interval = 200) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        try {
          const result = predicate();
          if (result) { resolve(result); return; }
        } catch (_) { /* ignore transient DOM errors */ }
        if (Date.now() - start >= timeout) { resolve(null); return; }
        setTimeout(check, interval);
      };
      check();
    });
  }

  /**
   * Sleep for `ms` milliseconds.
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 2 — URL / NAVIGATION HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Regular expression that matches the Vantagepoint Timekeeper URL hash.
   * Captures: (1) employee code, (2) ISO end date.
   *
   * Example hash:
   *   #!Timekeeper/view/0/0/1234%7C2026-01-18%7C%20/presentation
   */
  const HASH_PATTERN = /Timekeeper\/view\/\d+\/\d+\/([^%|]+)[%|]7C([0-9]{4}-[0-9]{2}-[0-9]{2})/i;

  /**
   * Parse the employee code and end-date from the current URL hash.
   * Returns null if the hash doesn't match the expected pattern.
   * @returns {{ employeeCode: string, endDate: Date }|null}
   */
  function parseCurrentHash() {
    // Decode percent-encoding first so %7C becomes |
    const decoded = decodeURIComponent(window.location.hash);
    const match   = decoded.match(/Timekeeper\/view\/\d+\/\d+\/([^|]+)\|([0-9]{4}-[0-9]{2}-[0-9]{2})/i);
    if (!match) {
      // Also try undecoded form
      const raw = window.location.hash.match(HASH_PATTERN);
      if (!raw) return null;
      return { employeeCode: raw[1], endDate: parseDate(raw[2]) };
    }
    return { employeeCode: match[1], endDate: parseDate(match[2]) };
  }

  /**
   * Build the Timekeeper URL hash for a given employee code and end date.
   * @param {string} employeeCode
   * @param {Date}   endDate
   * @returns {string}  the full hash string starting with "#"
   */
  function buildHash(employeeCode, endDate) {
    const isoEnd = formatDateISO(endDate);
    return `#!Timekeeper/view/0/0/${encodeURIComponent(employeeCode)}%7C${isoEnd}%7C%20/presentation`;
  }

  /**
   * Navigate to a specific period by changing location.hash.
   * @param {string} employeeCode
   * @param {Date}   endDate
   */
  function navigateToPeriod(employeeCode, endDate) {
    window.location.hash = buildHash(employeeCode, endDate).replace(/^#/, '');
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 3 — DOM SCRAPING
  // ═══════════════════════════════════════════════════════════════════════════════

  /** Pattern for a date-range period label, e.g. "1/5/2026 - 1/18/2026" */
  const PERIOD_LABEL_RE = /(\d{1,2}\/\d{1,2}\/\d{4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{4})/;

  /**
   * Pattern for a column date header, e.g. "Mon 1/5" or "Sat 3/31".
   * Anchored to REAL day-of-week names to exclude VP columns like "Per 1/31",
   * "End 1/31", "Tot 1/31", etc. that would otherwise match the looser form.
   */
  const DATE_HEADER_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*\d{1,2}\/\d{1,2}$/;

  /** Pattern for a numeric project code, e.g. "22059-01" */
  const PROJECT_CODE_RE = /^\d{5}-\d+$/;

  /** Pattern for an alphanumeric project code, e.g. "22AB001" */
  const PROJECT_CODE_ALPHA_RE = /^\d{2}[A-Z]{2,6}\d*/;

  /**
   * Attempt to find the period label text somewhere on the page.
   * Returns the raw matched string (e.g. "1/5/2026 - 1/18/2026") or null.
   * @returns {string|null}
   */
  function findPeriodLabel() {
    // Strategy 1: Look for any element whose text contains a date-range pattern
    const allText = document.querySelectorAll('*');
    for (const el of allText) {
      if (el.children.length > 3) continue; // skip container elements
      const t = getText(el);
      const m = t.match(PERIOD_LABEL_RE);
      if (m) return m[0].trim();
    }
    // Strategy 2: Parse from the current URL hash
    const parsed = parseCurrentHash();
    if (parsed) {
      // We only know the end date; start date is unknown without a label
      return null;
    }
    return null;
  }

  /**
   * Find BOTH the metadata table (frozen left columns) and the hour table
   * (scrollable date columns) in Vantagepoint's split-table layout.
   *
   * VP renders timesheets as two separate <table> elements:
   *   • Metadata table  — project code, name, client, phase, task (no inputs)
   *   • Hour table      — one column per day, cells contain <input> hour values
   *
   * Returns null if either table cannot be found.
   *
   * @returns {{ metaTable: Element, hourTable: Element, headers: Array }|null}
   */
  /**
   * Return true if `el` or any of its descendants contains a project-code string.
   * Checks `el.innerText` (catches nested spans/divs), then the value of any
   * child <input> elements.
   * @param {Element} el
   * @returns {boolean}
   */
  function cellHasProjectCode(el) {
    // innerText of the cell itself (includes nested text nodes)
    const t = (el.innerText || el.textContent || '').trim();
    if (PROJECT_CODE_RE.test(t) || PROJECT_CODE_ALPHA_RE.test(t)) return true;
    // Also check input values nested inside the cell
    for (const inp of el.querySelectorAll('input')) {
      const v = (inp.value || '').trim();
      if (PROJECT_CODE_RE.test(v) || PROJECT_CODE_ALPHA_RE.test(v)) return true;
    }
    return false;
  }

  function findTimesheetTables() {
    // Step 1: find the hour table — it has a <tr> with ≥5 date-header cells
    let hourTable = null;
    let headers   = [];
    for (const table of document.querySelectorAll('table')) {
      const hdrs = collectDateHeaders(table);
      if (hdrs.length >= 5) { hourTable = table; headers = hdrs; break; }
    }
    if (!hourTable || headers.length === 0) {
      console.log('[TS] findTimesheetTables: no hour table found (no table with ≥5 date headers)');
      return null;
    }
    console.log(`[TS] findTimesheetTables: hour table found, ${headers.length} headers`);

    // Step 2: find the metadata table — a DIFFERENT <table> that contains
    // at least one project-code-looking cell
    let metaTable = null;
    for (const table of document.querySelectorAll('table')) {
      if (table === hourTable) continue;
      for (const td of table.querySelectorAll('td')) {
        if (cellHasProjectCode(td)) { metaTable = table; break; }
      }
      if (metaTable) break;
    }

    if (!metaTable) {
      console.log('[TS] findTimesheetTables: no metadata table found — listing all tables:');
      let idx = 0;
      for (const tbl of document.querySelectorAll('table')) {
        const trs = tbl.querySelectorAll('tr');
        const firstTds = trs.length > 0
          ? Array.from(trs[0].querySelectorAll('td,th')).slice(0, 5).map(c => (c.innerText || c.textContent || '').trim().slice(0, 25))
          : [];
        console.log(`[TS]   table[${idx}] rows=${trs.length} firstRow=[${firstTds.join(' | ')}]`);
        idx++;
      }
      return null;
    }

    const metaDataRows = getDataRows(metaTable);
    const hourDataRows = getDataRows(hourTable);
    console.log(`[TS] findTimesheetTables: meta table found — metaDataRows=${metaDataRows.length}, hourDataRows=${hourDataRows.length}`);
    return { metaTable, hourTable, headers };
  }

  /**
   * Single-table fallback: find the timesheet table/grid in the DOM.
   * Returns an object { table, headers } where:
   *   - table   is the root element of the timesheet
   *   - headers is an array of { text, el } objects for the date columns
   * Returns null if nothing suitable is found.
   * @returns {{ table: Element, headers: Array<{text:string, el:Element}> }|null}
   */
  function findTimesheetTable() {
    // Try a <table> that contains BOTH date headers AND project codes.
    for (const table of document.querySelectorAll('table')) {
      const hdrs = collectDateHeaders(table);
      if (hdrs.length < 5) continue;
      let hasData = false;
      for (const td of table.querySelectorAll('td,th')) {
        const t = getText(td).trim();
        if (PROJECT_CODE_RE.test(t) || PROJECT_CODE_ALPHA_RE.test(t)) { hasData = true; break; }
      }
      if (hasData) return { table, headers: hdrs };
    }

    // Any container with a "timesheet" class
    const tsEl = document.querySelector('[class*="timesheet"],[class*="Timesheet"]');
    if (tsEl) {
      const hdrs = collectDateHeaders(tsEl);
      if (hdrs.length > 0) return { table: tsEl, headers: hdrs };
    }

    // Any div/section with date headers
    for (const div of document.querySelectorAll('div,section,article')) {
      const hdrs = collectDateHeaders(div);
      if (hdrs.length >= 5) return { table: div, headers: hdrs };
    }

    return null;
  }

  /**
   * Collect date-header elements within `root` that match DATE_HEADER_RE.
   *
   * Strategy A (preferred): find the <tr> with the most date-matching cells.
   *   Records each header's column index (colIdx) so buildRowFromCells can do
   *   direct column lookup instead of fragile positional math. Deduplicates by
   *   date text so VP's 4-sub-column-per-day layout collapses to one entry per
   *   day (keeping the first / "Regular" column).
   *
   * Strategy B (fallback): original element scan, now also deduplicated.
   *
   * @param {Element} root
   * @returns {Array<{text: string, el: Element, colIdx?: number}>}
   */
  function collectDateHeaders(root) {
    const seenTexts = new Set();

    // ── Strategy A: find the <tr> with the most date cells ───────────────────
    let bestTr = null, bestCount = 0;
    for (const tr of root.querySelectorAll('tr')) {
      let count = 0;
      for (const c of tr.querySelectorAll('th,td')) {
        if (DATE_HEADER_RE.test(getText(c).replace(/\s+/g, ' ').trim())) count++;
      }
      if (count > bestCount) { bestCount = count; bestTr = tr; }
    }

    if (bestTr && bestCount >= 5) {
      const cells = Array.from(bestTr.querySelectorAll('th,td'));
      const headers = [];
      for (const cell of cells) {
        const t = getText(cell).replace(/\s+/g, ' ').trim();
        if (!DATE_HEADER_RE.test(t)) continue;
        const normalized = t.replace(/^([A-Z][a-z]{2})(\d)/, '$1 $2');
        if (!seenTexts.has(normalized)) {
          seenTexts.add(normalized);
          // cellIndex is the browser-native column position — works even with colspan
          const ci = (cell.cellIndex !== undefined && cell.cellIndex >= 0) ? cell.cellIndex : null;
          headers.push({ text: normalized, el: cell, cellIndex: ci });
        }
      }
      if (headers.length >= 5) return headers;
    }

    // ── Strategy B: fallback element scan (deduplicated) ─────────────────────
    const headers = [];
    const candidates = root.querySelectorAll('th,td,div,span,li,button');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const t = getText(el).replace(/\s+/g, ' ').trim();
      if (!DATE_HEADER_RE.test(t)) continue;
      const normalized = t.replace(/^([A-Z][a-z]{2})(\d)/, '$1 $2');
      if (!seenTexts.has(normalized)) {
        seenTexts.add(normalized);
        headers.push({ text: normalized, el });
      }
    }
    return headers;
  }

  /**
   * Get data rows (non-header <tr> elements) from a table.
   * Skips rows that have no <td> cells, are all-<th>, or whose every non-empty
   * cell matches the date-header pattern (i.e. are header rows).
   *
   * @param {Element} table
   * @returns {HTMLTableRowElement[]}
   */
  function getDataRows(table) {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (tds.length < 2) continue;
      // Skip rows where every non-empty cell looks like a date header
      const nonEmpty = tds.map(td => getText(td).trim()).filter(Boolean);
      if (nonEmpty.length > 0 && nonEmpty.every(t => DATE_HEADER_RE.test(t))) continue;
      rows.push(tr);
    }
    return rows;
  }

  /**
   * Extract rows using VP's split-table layout by pairing metadata rows with
   * hour rows at the same index.
   *
   * @param {Element}  metaTable  frozen-left table (project code, name, phase…)
   * @param {Element}  hourTable  scrollable-right table (one cell per day)
   * @param {Array}    headers    date headers from collectDateHeaders(hourTable)
   * @returns {Object[]}
   */
  function extractFromTwoTables(metaTable, hourTable, headers) {
    const metaRows = getDataRows(metaTable);
    const hourRows = getDataRows(hourTable);
    console.log(`[TS] extractFromTwoTables: metaRows=${metaRows.length}, hourRows=${hourRows.length}, headers=${headers.length}`);

    const rows = [];
    const len  = Math.min(metaRows.length, hourRows.length);
    for (let i = 0; i < len; i++) {
      const metaCells = Array.from(metaRows[i].querySelectorAll('td,th'));
      const hourCells = Array.from(hourRows[i].querySelectorAll('td,th'));
      const rowData   = buildRowFromSplitCells(metaCells, hourCells, headers);
      if (rowData) rows.push(rowData);
    }
    console.log(`[TS] extractFromTwoTables: extracted ${rows.length} rows`);
    return rows;
  }

  /**
   * Build a row object from separate metadata cells and hour cells.
   *
   * • metaCells — come from the frozen metadata table row (project code, name, etc.)
   * • hourCells — come from the scrollable hour table row; hourCells[j] maps
   *               POSITIONALLY to headers[j], no cellIndex math needed.
   *
   * @param {Element[]} metaCells
   * @param {Element[]} hourCells
   * @param {Array}     headers
   * @returns {Object|null}
   */
  function buildRowFromSplitCells(metaCells, hourCells, headers) {
    const texts = metaCells.map(c => getText(c).trim());

    // Find project code in metadata cells
    let projectIdx = -1;
    for (let i = 0; i < texts.length; i++) {
      if (PROJECT_CODE_RE.test(texts[i]) || PROJECT_CODE_ALPHA_RE.test(texts[i])) {
        projectIdx = i;
        break;
      }
    }
    // Fallback: short overhead labels (PTO, Reg Holiday, Huddle, etc.)
    if (projectIdx === -1) {
      for (let i = 0; i < Math.min(3, texts.length); i++) {
        const t = texts[i];
        if (t && t.length >= 2 && t.length <= 40
            && !/^\d+\.?\d*$/.test(t)
            && !/\d+\/\d+/.test(t)
            && !/^(total|hours|project|code|description|client|phase|task|type|period|week|pay)/i.test(t)) {
          projectIdx = i;
          break;
        }
      }
    }
    if (projectIdx === -1) return null;

    const project     = texts[projectIdx]     || '';
    const projectName = texts[projectIdx + 1] || '';
    const client      = texts[projectIdx + 2] || '';
    const phase       = texts[projectIdx + 3] || '';
    const phaseName   = texts[projectIdx + 4] || '';
    const task        = texts[projectIdx + 5] || '';

    // Extract daily hours positionally: hourCells[j] → headers[j].text
    const dailyHours = {};
    for (let j = 0; j < Math.min(hourCells.length, headers.length); j++) {
      const cell  = hourCells[j];
      const input = cell.querySelector && cell.querySelector('input');
      const raw   = (input ? input.value : getText(cell)).replace(/,/g, '').trim();
      const hrs   = parseFloat(raw);
      if (!isNaN(hrs) && hrs > 0 && hrs <= 24) {
        dailyHours[headers[j].text] = hrs;
      }
    }

    return {
      project,
      projectName: projectName.replace(project, '').trim() || projectName,
      client,
      phase,
      phaseName,
      task,
      dailyHours,
    };
  }

  /**
   * Single-table fallback: extract row data from a classic HTML <tr>/<td> structure.
   * Used when VP's split-table layout is not detected.
   *
   * @param {Element}                         root
   * @param {Array<{text:string, el:Element}>} headers
   * @returns {Array<Object>}
   */
  function extractRows(root, headers) {
    const trRows = root.querySelectorAll('tr');
    if (trRows.length > 0) {
      const rows = [];
      for (const tr of trRows) {
        const cells = Array.from(tr.querySelectorAll('td,th'));
        if (cells.length < 2) continue;
        const rowData = buildRowFromCellsFallback(cells, headers);
        if (rowData) rows.push(rowData);
      }
      if (rows.length > 0) return rows;
    }
    return [];
  }

  /**
   * Single-table fallback row builder.
   * Used only when the two-table approach is unavailable.
   *
   * @param {Element[]}                        cells
   * @param {Array<{text:string, el:Element}>} headers
   * @returns {Object|null}
   */
  function buildRowFromCellsFallback(cells, headers) {
    const texts = cells.map(c => getText(c).trim());

    let projectIdx = -1;
    for (let i = 0; i < texts.length; i++) {
      if (PROJECT_CODE_RE.test(texts[i]) || PROJECT_CODE_ALPHA_RE.test(texts[i])) {
        projectIdx = i; break;
      }
    }
    if (projectIdx === -1) {
      for (let i = 0; i < Math.min(3, texts.length); i++) {
        const t = texts[i];
        if (t && t.length >= 2 && t.length <= 40
            && !/^\d+\.?\d*$/.test(t)
            && !/\d+\/\d+/.test(t)
            && !/^(total|hours|project|code|description|client|phase|task|type|period|week|pay)/i.test(t)) {
          projectIdx = i; break;
        }
      }
    }
    if (projectIdx === -1) return null;

    const project     = texts[projectIdx]     || '';
    const projectName = texts[projectIdx + 1] || '';
    const client      = texts[projectIdx + 2] || '';
    const phase       = texts[projectIdx + 3] || '';
    const phaseName   = texts[projectIdx + 4] || '';
    const task        = texts[projectIdx + 5] || '';

    const dailyHours = {};
    const firstHourIdx = projectIdx + 6;
    let hIdx = 0;
    for (let i = firstHourIdx; i < cells.length && hIdx < headers.length; i++) {
      const cell  = cells[i];
      const input = cell.querySelector && cell.querySelector('input');
      const raw   = (input ? input.value : getText(cell)).replace(/,/g, '').trim();
      const hrs   = parseFloat(raw);
      if (!isNaN(hrs) && hrs >= 0 && hrs <= 24) {
        dailyHours[headers[hIdx].text] = hrs;
        hIdx++;
      }
    }

    return {
      project,
      projectName: projectName.replace(project, '').trim() || projectName,
      client,
      phase,
      phaseName,
      task,
      dailyHours,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 4 — EMPLOYEE NAME DETECTION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Best-effort attempt to find the logged-in employee's display name.
   * Tries several common selectors used in Vantagepoint and generic patterns.
   * @returns {string}
   */
  function detectEmployeeName() {
    const selectors = [
      '[data-employee-name]',
      '.employee-name',
      '.user-name',
      '.user-display-name',
      '.vp-user-name',
      '[class*="userName"]',
      '[class*="employeeName"]',
      '[class*="userDisplay"]',
      // Vantagepoint top-nav area
      'header .name',
      'nav .name',
      '.top-bar .name',
      '.toolbar .name',
    ];

    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) {
          const t = (el.getAttribute('data-employee-name') || getText(el)).trim();
          if (t && t.length > 1 && t.length < 100) return t;
        }
      } catch (_) { /* ignore */ }
    }

    // Fall back to document.title (VP often puts the employee name there)
    const title = document.title || '';
    if (title && title.length > 1 && title.length < 80) return title.replace(/\s*[-|].*$/, '').trim();

    return 'Unknown Employee';
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 5 — UI PANEL
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Create and inject the floating progress panel into the page.
   * Returns an object with methods to update status, set progress, and show buttons.
   * @returns {Object}
   */
  function createPanel() {
    // Remove any existing panel (in case of re-runs)
    const existing = document.getElementById('__ts-extractor-panel');
    if (existing) existing.remove();

    const HARD_MIN_DATE = '1990-01-01';
    const DEFAULT_DATE  = '2010-01-01';
    const today         = new Date().toISOString().slice(0, 10);

    const panel = document.createElement('div');
    panel.id = '__ts-extractor-panel';
    panel.style.cssText = [
      'position: fixed',
      'top: 20px',
      'right: 20px',
      'z-index: 999999',
      'background: #100f0f',
      'color: #cecdc3',
      'font: 13px/1.5 system-ui, -apple-system, sans-serif',
      'border-radius: 10px',
      'padding: 16px 18px',
      'min-width: 290px',
      'max-width: 340px',
      'box-shadow: 0 4px 24px rgba(0,0,0,0.55), 0 1px 4px rgba(0,0,0,0.35)',
      'user-select: none',
    ].join('; ');

    // ── Phase 1: setup screen ────────────────────────────────────────────────
    panel.innerHTML = `
      <div id="__ts-setup">
        <div style="margin-bottom:14px">
          <strong style="font-size:14px;color:#fffcf0">Timesheet Extractor</strong>
          <div style="font-size:11px;color:#878580;margin-top:3px">Retrospectacles data export</div>
        </div>

        <div style="margin-bottom:14px">
          <label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;
            letter-spacing:.08em;color:#878580;margin-bottom:6px">
            Collect history back to
          </label>
          <input type="date" id="__ts-start-date"
            value="${DEFAULT_DATE}"
            min="${HARD_MIN_DATE}"
            max="${today}"
            style="width:100%;padding:7px 10px;background:#1c1b1a;border:1px solid #403e3c;
              border-radius:6px;color:#fffcf0;font:13px system-ui;outline:none;
              box-sizing:border-box;cursor:pointer"
          >
          <div style="font-size:11px;color:#575653;margin-top:5px">
            Default 2010 &nbsp;·&nbsp; Earliest allowed: 1990
          </div>
        </div>

        <div style="display:flex;gap:8px">
          <button id="__ts-cancel-btn" style="
            flex:1;padding:8px 10px;border:1px solid #403e3c;border-radius:6px;
            background:transparent;color:#9f9d96;font:13px system-ui;cursor:pointer">
            Cancel
          </button>
          <button id="__ts-start-btn" style="
            flex:2;padding:8px 10px;border:none;border-radius:6px;
            background:#24837b;color:#fff;font:600 13px system-ui;cursor:pointer">
            Start Extraction →
          </button>
        </div>
      </div>

      <div id="__ts-progress" style="display:none">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <strong style="font-size:14px;color:#fffcf0">Timesheet Extractor</strong>
          <span id="__ts-count" style="font-size:12px;color:#878580">0 periods</span>
        </div>
        <div id="__ts-status" style="color:#fffcf0;margin-bottom:10px;font-size:12px;min-height:32px">
          Starting…
        </div>
        <div style="background:#282726;border-radius:4px;height:6px;margin-bottom:12px;overflow:hidden">
          <div id="__ts-bar" style="background:#24837b;height:100%;width:0%;transition:width 0.3s ease"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button id="__ts-stop" style="
            flex:1;padding:7px 10px;border:none;border-radius:6px;
            background:#d14d41;color:#fff;font:13px system-ui;cursor:pointer;
            transition:opacity 0.2s">Stop</button>
          <button id="__ts-download" style="
            flex:1;padding:7px 10px;border:none;border-radius:6px;
            background:#24837b;color:#fff;font:13px system-ui;cursor:pointer;
            opacity:0.4;pointer-events:none;transition:opacity 0.2s">Download JSON</button>
        </div>
        <div id="__ts-diag" style="margin-top:10px;font-size:11px;color:#878580;display:none;
          max-height:120px;overflow-y:auto;white-space:pre-wrap;word-break:break-word"></div>
      </div>
    `;

    document.body.appendChild(panel);

    // ── Shortcuts to progress-phase elements (bound after setup exits) ────────
    let statusEl, countEl, barEl, stopBtn, downloadBtn, diagEl;

    function bindProgressEls() {
      statusEl    = panel.querySelector('#__ts-status');
      countEl     = panel.querySelector('#__ts-count');
      barEl       = panel.querySelector('#__ts-bar');
      stopBtn     = panel.querySelector('#__ts-stop');
      downloadBtn = panel.querySelector('#__ts-download');
      diagEl      = panel.querySelector('#__ts-diag');
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
      /**
       * Show the setup screen and wait for the user to choose a start date.
       * Resolves with { earliestDate: Date } or null if cancelled.
       */
      awaitStart() {
        return new Promise((resolve) => {
          const startBtn  = panel.querySelector('#__ts-start-btn');
          const cancelBtn = panel.querySelector('#__ts-cancel-btn');
          const dateInput = panel.querySelector('#__ts-start-date');

          startBtn.addEventListener('click', () => {
            // Parse and clamp the chosen date
            const raw  = dateInput.value || DEFAULT_DATE;
            let chosen = new Date(raw + 'T12:00:00');
            const hardMin = new Date(HARD_MIN_DATE + 'T12:00:00');
            if (isNaN(chosen.getTime()) || chosen < hardMin) chosen = hardMin;

            // Transition to progress view
            panel.querySelector('#__ts-setup').style.display    = 'none';
            panel.querySelector('#__ts-progress').style.display = 'block';
            bindProgressEls();

            resolve({ earliestDate: chosen });
          });

          cancelBtn.addEventListener('click', () => {
            panel.remove();
            resolve(null);
          });
        });
      },

      setStatus(text, subtext) {
        if (!statusEl) return;
        statusEl.innerHTML = `<span style="color:#fffcf0">${text}</span>` +
          (subtext ? `<br><span style="color:#878580;font-size:11px">${subtext}</span>` : '');
      },
      setCount(n) {
        if (countEl) countEl.textContent = `${n} period${n === 1 ? '' : 's'}`;
      },
      setProgress(pct) {
        if (barEl) barEl.style.width = Math.min(100, Math.max(0, pct)) + '%';
      },
      enableDownload(onClickFn) {
        if (!downloadBtn) return;
        downloadBtn.style.opacity      = '1';
        downloadBtn.style.pointerEvents = 'auto';
        downloadBtn.addEventListener('click', onClickFn);
      },
      disableStop() {
        if (stopBtn) { stopBtn.style.opacity = '0.4'; stopBtn.style.pointerEvents = 'none'; }
      },
      onStop(fn) {
        if (stopBtn) stopBtn.addEventListener('click', fn);
      },
      showDiagnostic(text) {
        if (!diagEl) return;
        diagEl.style.display = 'block';
        diagEl.textContent   = text;
      },
      remove() { panel.remove(); }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 6 — DIAGNOSTIC HELPER
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Generate a brief diagnostic description of all tables found on the page.
   * Used when the timesheet table cannot be found automatically.
   * @returns {string}
   */
  function buildDiagnostic() {
    const tables = document.querySelectorAll('table');
    const parts  = [];
    parts.push(`Page title: "${document.title}"`);
    parts.push(`Hash: "${window.location.hash.substring(0, 80)}"`);
    parts.push(`Tables found: ${tables.length}`);
    let shown = 0;
    for (const t of tables) {
      if (shown >= 3) break;
      const rows = t.querySelectorAll('tr');
      const firstRows = [];
      let r = 0;
      for (const row of rows) {
        if (r >= 3) break;
        firstRows.push(
          Array.from(row.querySelectorAll('td,th'))
            .slice(0, 5)
            .map(c => getText(c).replace(/\s+/g, ' ').substring(0, 20))
            .join(' | ')
        );
        r++;
      }
      parts.push(`\nTable ${shown + 1} (${rows.length} rows):\n  ` + firstRows.join('\n  '));
      shown++;
    }
    return parts.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 7 — JSON DOWNLOAD
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Trigger a browser download of `data` serialized as JSON.
   * @param {Object} data
   * @param {string} filename
   */
  function downloadJSON(data, filename) {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION 8 — MAIN EXTRACTION LOOP
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Scrape the currently visible timesheet period.
   * Returns an object ready to be stored under its period key, or null on failure.
   *
   * @param {string}  employeeCode
   * @param {Date}    expectedEndDate  (used as fallback for period label)
   * @returns {Promise<{ periodKey: string, startDate: Date|null, data: Object }|null>}
   */
  async function scrapeCurrentPeriod(employeeCode, expectedEndDate) {
    // Wait for date headers to appear — this is our signal that the page has rendered.
    // We wait for EITHER the two-table layout (preferred) OR the single-table layout.
    const twoTableResult = await waitFor(() => findTimesheetTables(), 8000, 250);

    // Determine which mode we're in
    let headers, twoTable = null;
    if (twoTableResult) {
      headers  = twoTableResult.headers;
      twoTable = twoTableResult;
    } else {
      // Fall back to single-table detection
      const singleResult = await waitFor(() => {
        const ts = findTimesheetTable();
        return (ts && ts.headers.length > 0) ? ts : null;
      }, 4000, 250);
      if (!singleResult) return null;
      headers = singleResult.headers;
    }

    if (!headers || headers.length === 0) return null;

    // ── Find period label ─────────────────────────────────────────────────────
    let periodLabel = null;
    let startDate   = null;
    let endDate     = expectedEndDate;

    try {
      periodLabel = findPeriodLabel();
      if (periodLabel) {
        const m = periodLabel.match(PERIOD_LABEL_RE);
        if (m) {
          startDate   = parseDate(m[1]);
          endDate     = parseDate(m[2]) || expectedEndDate;
          periodLabel = formatDate(startDate) + ' - ' + formatDate(endDate);
        }
      }
    } catch (e) {
      console.warn('[TimesheetExtractor] Could not parse period label:', e);
    }

    if (!periodLabel) {
      endDate     = expectedEndDate;
      startDate   = subtractDays(endDate, 13);
      periodLabel = formatDate(startDate) + ' - ' + formatDate(endDate);
    }

    // ── Extract rows ──────────────────────────────────────────────────────────
    let rows = [];
    let _debug = null;
    try {
      if (twoTable) {
        console.log(`[TS] scrapeCurrentPeriod: using two-table mode for "${periodLabel}"`);
        rows = extractFromTwoTables(twoTable.metaTable, twoTable.hourTable, headers);
      } else {
        console.log(`[TS] scrapeCurrentPeriod: using single-table fallback for "${periodLabel}"`);
        const singleTs = findTimesheetTable();
        if (singleTs) rows = extractRows(singleTs.table, headers);
      }

      // Diagnostic snapshot for the first scraped period — remove once verified
      if (!window.__tsDebugCaptured) {
        window.__tsDebugCaptured = true;
        try {
          const dumpRow = tds => tds.slice(0, 10).map(c => ({
            t: (c.innerText || c.textContent || '').trim().slice(0, 25),
            ci: c.cellIndex,
            v: c.querySelector('input') ? c.querySelector('input').value : null,
          }));
          const allTables = Array.from(document.querySelectorAll('table')).map((tbl, i) => {
            const allTrs = Array.from(tbl.querySelectorAll('tr'));
            const dataTrs = allTrs.filter(tr => tr.querySelectorAll('td').length >= 2);
            return {
              i,
              rows: allTrs.length,
              dataTrs: dataTrs.length,
              firstRowCells: dataTrs.length ? dumpRow(Array.from(dataTrs[0].querySelectorAll('td,th'))) : [],
              isMetaTable: twoTable ? tbl === twoTable.metaTable : false,
              isHourTable: twoTable ? tbl === twoTable.hourTable : false,
            };
          });
          _debug = {
            mode: twoTable ? 'two-table' : 'single-table',
            headers: headers.map(h => h.text),
            allTables,
            rowsExtracted: rows.length,
          };
          console.log('[TS] _debug:', JSON.stringify(_debug, null, 2));
        } catch (de) {
          _debug = { error: String(de) };
        }
      }
    } catch (e) {
      console.warn('[TimesheetExtractor] Row extraction error:', e);
    }

    const dateHeaderTexts = headers.map(h => h.text);

    return {
      periodKey: periodLabel,
      startDate,
      data: {
        period:      periodLabel,
        dateHeaders: dateHeaderTexts,
        rows,
        ...(_debug ? { _debug } : {}),
      },
    };
  }

  /**
   * Main entry point. Orchestrates the multi-period navigation and scraping loop.
   */
  async function main() {
    // ── Parse initial state from URL ──────────────────────────────────────────
    const initial = parseCurrentHash();
    if (!initial) {
      alert(
        'Could not read employee code from the current URL.\n\n' +
        'Please navigate directly to a timesheet in Timekeeper and try again.\n\n' +
        'Current hash: ' + window.location.hash.substring(0, 120)
      );
      window.__timesheetExtractorRunning = false;
      return;
    }

    const { employeeCode } = initial;
    let currentEndDate     = initial.endDate;

    // ── Set up output accumulator ─────────────────────────────────────────────
    const output = {
      name: detectEmployeeName()
    };

    // ── Set up UI panel — show setup screen first ─────────────────────────────
    const panel = createPanel();

    // Wait for the user to choose a start date (or cancel)
    const startConfig = await panel.awaitStart();
    if (!startConfig) {
      // User clicked Cancel
      window.__timesheetExtractorRunning = false;
      return;
    }

    let stopped = false;
    let consecutiveEmpty = 0;
    const EARLIEST_DATE  = startConfig.earliestDate;
    const MAX_EMPTY_RUNS = 3;

    panel.setStatus('Detecting employee…', `Code: ${employeeCode}`);

    panel.onStop(() => {
      stopped = true;
      panel.setStatus('Stopping…', 'Will finish current period then stop.');
    });

    // Download button handler (enabled when data is available)
    function triggerDownload() {
      if (Object.keys(output).length <= 1) {
        panel.showDiagnostic('No data collected yet.');
        return;
      }
      downloadJSON(output, 'retrospectacles-data.json');
      panel.setStatus('Download started!', 'Check your Downloads folder.');
    }

    // ── Scraping loop ─────────────────────────────────────────────────────────
    let periodsCollected = 0;

    while (!stopped) {
      // Bail out if we've gone far enough back in history
      if (currentEndDate < EARLIEST_DATE) {
        panel.setStatus('All history collected.', 'Nothing before 2010.');
        break;
      }

      // Navigate to this period
      panel.setStatus(
        `Scraping period ending ${formatDate(currentEndDate)}…`,
        `${periodsCollected} period${periodsCollected === 1 ? '' : 's'} collected so far`
      );
      navigateToPeriod(employeeCode, currentEndDate);

      // Give the SPA router a moment to start rendering
      await sleep(800);

      // Scrape
      let result = null;
      try {
        result = await scrapeCurrentPeriod(employeeCode, currentEndDate);
      } catch (e) {
        console.error('[TimesheetExtractor] Unexpected error scraping period:', e);
      }

      if (!result) {
        // Page did not render a recognizable timesheet
        consecutiveEmpty++;
        console.warn(
          `[TimesheetExtractor] Period ending ${formatDate(currentEndDate)} produced no data ` +
          `(${consecutiveEmpty} consecutive empty).`
        );
        if (consecutiveEmpty >= MAX_EMPTY_RUNS) {
          panel.setStatus('No data found for 3 periods in a row.', 'Stopping early.');
          panel.showDiagnostic(buildDiagnostic());
          break;
        }
        // Subtract 14 days as a fallback and keep going
        currentEndDate = subtractDays(currentEndDate, 14);
        continue;
      }

      consecutiveEmpty = 0;

      // Store the result (only if not already present — avoid duplicates on retry)
      if (!output[result.periodKey]) {
        output[result.periodKey] = result.data;
        periodsCollected++;
        panel.setCount(periodsCollected);

        // Update employee name if still default
        if (output.name === 'Unknown Employee') {
          output.name = detectEmployeeName();
        }

        // Enable download once we have something
        if (periodsCollected === 1) {
          panel.enableDownload(triggerDownload);
        }
      }

      // Advance: previous period ends the day before this period's start
      if (result.startDate) {
        currentEndDate = subtractDays(result.startDate, 1);
      } else {
        // Fallback: assume 14-day periods
        currentEndDate = subtractDays(currentEndDate, 14);
      }

      // Animate progress bar — no well-defined end, so use a log-scale heuristic
      const logProgress = Math.min(95, (periodsCollected / 52) * 100);
      panel.setProgress(logProgress);
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    window.__timesheetExtractorRunning = false;
    panel.disableStop();
    panel.setProgress(100);

    if (periodsCollected === 0) {
      panel.setStatus(
        'No timesheet data found.',
        'Make sure you are on the Timekeeper page and fully logged in.'
      );
      panel.showDiagnostic(buildDiagnostic());
    } else {
      panel.setStatus(
        `Done! ${periodsCollected} period${periodsCollected === 1 ? '' : 's'} collected.`,
        `Employee: ${output.name}`
      );
      panel.enableDownload(triggerDownload);
      // Auto-download
      triggerDownload();
    }
  }

  // ── Kick off ─────────────────────────────────────────────────────────────────
  main().catch((err) => {
    console.error('[TimesheetExtractor] Fatal error:', err);
    window.__timesheetExtractorRunning = false;
    alert('Timesheet extractor encountered an unexpected error. See the browser console for details.');
  });

})();
