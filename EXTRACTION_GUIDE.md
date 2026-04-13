# Vantagepoint Timesheet Extraction Guide

**Retrospect Career Visualization Dashboard — Data Loading Workflow**

---

## 1. Overview

This guide describes how to use an AI agent (Claude with browser access via the `mcp__Claude_in_Chrome` tool set) to extract your full timesheet history from Deltek Vantagepoint and load it into **Retrospect** — a personal career visualization dashboard that shows how your time has been spent across projects, clients, phases, and years.

**What this produces:** A structured JSON file containing every timesheet period you've worked, with daily hour breakdowns per project/phase/task row. Once uploaded to Retrospect, the dashboard processes this into interactive charts covering career-long billability, project diversity, client history, and more.

**What you need:**
- A Vantagepoint (VP) account with timesheet access
- Claude Code with browser MCP tools (`mcp__Claude_in_Chrome`) enabled
- The Retrospect dashboard (`index.html`) open in a browser or served locally
- Your VP employee/staff code (a 4-digit number found in your VP profile URL)
- Your first employment date at the firm

---

## 2. Prerequisites

### Vantagepoint Access
You must be able to log in to your firm's Vantagepoint instance and navigate to the Timekeeper module. The extraction reads timesheet data only — no write access is required.

### Claude Code with Browser MCP
The extraction uses the `mcp__Claude_in_Chrome` tool family, which gives Claude the ability to navigate, read, and interact with pages in a Chrome browser session. You must have this MCP configured and active in your Claude Code session.

### Retrospect Dashboard
The `index.html` dashboard file should be accessible in a browser (open as a local file or served via a local dev server). It includes an **"↑ Load data"** button in the header for uploading your extracted JSON.

### Your Employee Code
Your 4-digit staff ID is embedded in your Vantagepoint profile URL. Navigate to your profile in VP and look for a numeric code (e.g., `0550`) in the URL path. This code is used in the Timekeeper URL to identify whose timesheets are loaded.

---

## 3. How Vantagepoint Timesheets Are Structured

Vantagepoint organizes timesheets into **15-day periods**:

- **Period 1:** 1st – 15th of each month
- **Period 2:** 16th – last day of each month

Each period is displayed as a grid with:
- **Date columns** across the top (one column per calendar day in the period)
- **Rows** for each project/phase/task combination you logged time against
- Each row contains: project code, project name, client, phase code, phase name, task code, and the hours entered for each day

Periods with no time logged still appear as empty grids; the extraction should record them as empty or skip them.

---

## 4. The VP Timekeeper URL Pattern

Each timesheet period is directly accessible via a URL. The structure is:

```
https://[your-instance].vantagepoint.com/#!Timekeeper/view/0/0/{EMPLOYEE_CODE}%7C{END_DATE}%7C%20/presentation
```

**Key details:**

| Part | Description |
|------|-------------|
| `[your-instance]` | Your firm's VP subdomain (e.g., `lmn.vantagepoint.com`) |
| `{EMPLOYEE_CODE}` | Your 4-digit staff ID (e.g., `0550`) |
| `{END_DATE}` | The **end date** of the period in `YYYY-MM-DD` format |
| `%7C` | URL-encoded pipe character `\|` |
| `%20` | URL-encoded space (trailing separator) |

**The date in the URL is the END date of the period, not the start date.**

| Period | End Date | URL Fragment |
|--------|----------|-------------|
| Jan 1–15, 2026 | `2026-01-15` | `0550%7C2026-01-15%7C%20` |
| Jan 16–31, 2026 | `2026-01-31` | `0550%7C2026-01-31%7C%20` |
| Feb 1–15, 2026 | `2026-02-15` | `0550%7C2026-02-15%7C%20` |

**Full example URL:**
```
https://lmn.vantagepoint.com/#!Timekeeper/view/0/0/0550%7C2026-01-15%7C%20/presentation
```

To iterate over all periods, generate end-date pairs going backward from today:
- Current or most recent period: end of current half-month
- Previous period: end of prior half-month
- Continue back to your first employment date

---

## 5. The Extraction Prompt

Copy and paste the following prompt to Claude (in a session with `mcp__Claude_in_Chrome` tools available). Adjust the bracketed values before running.

---

```
You are going to extract my complete timesheet history from Vantagepoint and save it as a JSON file.

**Configuration:**
- VP base URL: https://[YOUR-INSTANCE].vantagepoint.com
- Employee code: [YOUR-CODE]  (e.g. 0550)
- First employment date: [YYYY-MM-DD]  (e.g. 2019-03-01)
- Output file: C:/Users/[you]/timesheet-export.json

**Login:** I am already logged in to Vantagepoint in Chrome. Do not log out or navigate away from the domain between periods.

**Period generation:** Generate a list of all 15-day period END DATES from today backward to my first employment date:
- For months: end dates are the 15th and the last day of the month
- Work backward chronologically (most recent first)

**For each period:**
1. Navigate to:
   `https://[YOUR-INSTANCE].vantagepoint.com/#!Timekeeper/view/0/0/[YOUR-CODE]%7C{END_DATE}%7C%20/presentation`
2. Wait for the timesheet grid to fully render (check for date header cells)
3. Read the page to extract:
   - The period label (e.g. "Jan 1 – 15, 2026")
   - The date headers from the column headers row. **Important:** date header formats vary by VP version:
     - Older periods: `"Thu 1/1"` — day-of-week, space, then M/D
     - Newer periods: `"Tue3/14"` — day-of-week immediately followed by M/D (no space)
     - Extract the M/D portion from both formats
   - For each timesheet row: project code, project name, client name, phase code, phase name, task code, and a dict of `{ "M/D": hours }` for each day with non-zero hours
4. Skip rows that are entirely zero / blank
5. Append the period object to the running JSON array

**Output JSON structure per period:**
```json
{
  "period": "Jan 1 – 15, 2026",
  "endDate": "2026-01-15",
  "dateHeaders": ["1/1","1/2","1/3","1/4","1/5","1/6","1/7","1/8","1/9","1/10","1/11","1/12","1/13","1/14","1/15"],
  "rows": [
    {
      "projectCode": "12345",
      "projectName": "Example Office Building",
      "client": "Example Client LLC",
      "phase": "30",
      "phaseName": "Design Development",
      "task": "210",
      "hours": { "1/6": 8, "1/7": 6, "1/8": 8 }
    }
  ]
}
```

**Saving progress:** After every 4 periods, write the accumulated array to the output file (overwriting). This ensures progress is saved if the session is interrupted. When all periods are complete, do a final write.

**When done:** Report the total number of periods extracted and the total number of non-empty rows found.
```

---

## 6. Output JSON Schema

The extraction produces a top-level JSON array of period objects. Annotated example:

```json
[
  {
    "period": "Jan 1 – 15, 2026",      // Human-readable period label
    "endDate": "2026-01-15",            // ISO end date of the period (matches URL)
    "dateHeaders": [                    // All calendar dates in this period (M/D format)
      "1/1","1/2","1/3","1/4","1/5",
      "1/6","1/7","1/8","1/9","1/10",
      "1/11","1/12","1/13","1/14","1/15"
    ],
    "rows": [
      {
        "projectCode": "12345",         // 5-digit project code
        "projectName": "North Tower Renovation",
        "client": "Acme Development Co.",
        "phase": "30",                  // Phase code
        "phaseName": "Design Development",
        "task": "210",                  // Task code
        "hours": {                      // Only days with non-zero hours
          "1/6": 8.0,
          "1/7": 6.5,
          "1/8": 8.0,
          "1/9": 7.0
        }
      },
      {
        "projectCode": "00010",         // Non-billable / overhead code
        "projectName": "Firm Administration",
        "client": "",
        "phase": "00",
        "phaseName": "General",
        "task": "100",
        "hours": {
          "1/5": 1.0,
          "1/8": 0.5
        }
      }
    ]
  },
  {
    "period": "Dec 16 – 31, 2025",
    "endDate": "2025-12-31",
    "dateHeaders": ["12/16","12/17", "..."],
    "rows": [ "..." ]
  }
]
```

**Notes on the schema:**
- Periods with no logged time may be omitted entirely or included with an empty `rows` array — the dashboard handles both
- The `hours` dict only needs entries for days where hours > 0; missing days are treated as 0
- `projectCode`, `phase`, and `task` are strings, not numbers (they may have leading zeros)

---

## 7. Loading into Retrospect

Once you have your `timesheet-export.json` file:

1. Open the Retrospect dashboard (`index.html`) in a browser
2. Click the **"↑ Load data"** button in the top-left of the header
3. Select your JSON file in the file picker

The dashboard will:
- Parse the JSON and run it through the same `processData()` pipeline as the embedded demo data
- Expand each period's rows into individual daily time entries
- Classify each entry as billable or non-billable based on project code
- Build project metadata maps, monthly aggregation buckets, and filter indexes
- Re-render all charts and filter controls to reflect your data range
- Show "✓ [filename]" briefly in the button as confirmation

The year-range filter will automatically update to span your full employment history. All other filters (project, phase, category) reset to show everything.

**The embedded demo data remains intact** — reloading the page returns to the demo. Your JSON file is never stored by the app; it is processed in memory only.

---

## 8. Troubleshooting

### Wrong period loads (shows different dates than expected)
The URL date must be the **end** date of the period, not the start. For the Jan 1–15 period, use `2026-01-15`. Using `2026-01-01` will load the Dec 16–31 period instead.

### Login session expires mid-extraction
VP sessions can time out during a long extraction run. If Claude reports that the page is showing a login screen, manually log back in to VP in Chrome and then ask Claude to resume from the last successfully saved period. The incremental file saves (every 4 periods) ensure you don't lose prior work.

### Date header format not parsed correctly
VP has changed its date header rendering across versions. Older timesheet periods render as `"Thu 1/1"` (space between weekday and date); newer ones render as `"Tue3/14"` (no space). The extraction prompt handles both patterns, but if your output shows missing or malformed date keys in the `hours` dict, check the raw page text for the header format and adjust the prompt's parsing instructions accordingly.

### Partial periods near employment start
Your first period may cover only part of a 15-day window (e.g., if you started on the 8th, the first period only has data from the 8th onward). This is fine — extract whatever dates are present. The dashboard handles sparse periods correctly.

### Empty periods included vs. excluded
If you have gaps (leave, sabbatical), those periods will have empty row arrays. Including them is harmless; excluding them saves file size. The dashboard counts total hours correctly either way.

### JSON parse error on upload
If the dashboard shows "Could not parse JSON," the file is likely incomplete (extraction was interrupted before a final write) or has a trailing comma or encoding issue. Open the file in a text editor, verify it is a valid JSON array (starts with `[`, ends with `]`), and check that the last period object is properly closed.

---

## 9. Adapting for Your Firm

### Change the employee code
Replace `0550` in the URL pattern with your own staff ID. Find it by navigating to your VP employee profile and reading the numeric segment from the URL.

### Change the VP instance URL
Replace `lmn.vantagepoint.com` with your firm's VP subdomain. The rest of the URL structure (`/#!Timekeeper/view/0/0/...`) is standard across Vantagepoint instances.

### Change the start date
Set the `First employment date` in the prompt to your actual hire date. The agent will stop generating periods once it reaches that date.

### Billable vs. non-billable classification
The Retrospect dashboard's `classify()` function identifies billable work by checking whether the project code is a **5-digit numeric code** (the convention used by LMN Tech Studio). Non-billable overhead, PTO, and administrative time use shorter or non-numeric codes.

If your firm uses a different project numbering convention, you will need to edit the `classify()` function in `index.html` to match your coding scheme. Look for the function by name in the script section and update the condition that tests `projectCode` to reflect your firm's billable vs. non-billable code patterns.

### Multiple staff exports
The JSON schema is per-employee. To show a team member's data, run a separate extraction with their employee code and load the resulting file. There is no multi-user merge feature in the current dashboard version.

---

*Last updated: April 2026*
