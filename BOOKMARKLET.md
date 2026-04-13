# Timesheet Extractor — Bookmarklet

> **No AI required. No account needed. Runs entirely in your browser.**
>
> This tool reads timesheet data directly from the Vantagepoint page you are
> already viewing. It does not send any data to any external server. The only
> output is a JSON file downloaded to your computer.

---

## What This Does

The bookmarklet navigates backwards through your Vantagepoint Timekeeper
history, reads every pay period, and downloads the result as a single JSON
file (`retrospectacles-data.json`). You can then load that file into
Retrospectacles to visualize where your time has gone.

---

## Installation

### Option A — Drag to Bookmarks Bar (easiest)

1. Make sure your bookmarks bar is visible.
   - Chrome / Edge: **Ctrl+Shift+B** (Windows) or **Cmd+Shift+B** (Mac)
   - Firefox: **View → Toolbars → Bookmarks Toolbar**

2. Drag the link below to your bookmarks bar:

   > [Extract Timesheets](javascript:(function(){var s=document.createElement('script');s.src='https://lmnts.github.io/retrospectacles/extract.js?_='+Date.now();document.head.appendChild(s);})();)

   *(Right-click → "Copy link address" if drag-and-drop is unavailable, then
   create a new bookmark manually and paste the URL into the Address/URL field.)*

### Option B — Create Manually

1. Right-click your bookmarks bar and choose **Add page** (Chrome/Edge) or
   **New Bookmark** (Firefox).
2. Set the **Name** to: `Extract Timesheets`
3. Set the **URL / Address** to the following (copy the entire line):

```
javascript:(function(){var s=document.createElement('script');s.src='https://lmnts.github.io/retrospectacles/extract.js?_='+Date.now();document.head.appendChild(s);})();
```

4. Save the bookmark.

---

## Usage (3 steps)

1. **Log in to Vantagepoint** as normal and open any timesheet in Timekeeper.
   You should see your current pay period displayed.

2. **Navigate to Timekeeper** — the URL should contain `#!Timekeeper` in the
   address bar. The bookmarklet will not run on any other page.

3. **Click the "Extract Timesheets" bookmark.** A panel will appear in the
   top-right corner of the page showing extraction progress. The script will
   automatically step backwards through every pay period. When finished, your
   browser will download `retrospectacles-data.json` automatically.

> **Tip:** You can click **Stop** at any time and then click **Download JSON**
> to save whatever has been collected so far.

---

## What to Do With the Downloaded JSON

1. Open **Retrospectacles.html** in your browser (double-click the file, or
   open it via File → Open in your browser).
2. Click the **Load** button (or the file-picker area).
3. Select the `retrospectacles-data.json` file you just downloaded.
4. Your timesheet history will load and you can explore charts and summaries.

---

## Security and Privacy

- The script only reads data that is already visible in your browser.
- No data is transmitted to any server — everything stays on your machine.
- The downloaded JSON file is a plain text file you can open in any text
  editor to inspect before loading it into Retrospectacles.
- Your IT department can review the full source code at:
  `https://lmnts.github.io/retrospectacles/extract.js`

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| Panel appears but shows "No timesheet data found" | Make sure you are on a Timekeeper page showing a timesheet (not the dashboard). Refresh, wait for the page to fully load, then click the bookmarklet again. |
| Panel never appears | Check the browser console (F12 → Console) for errors. Make sure popups / JavaScript are not blocked. |
| Only a few periods collected before stopping | This is normal if you have a short employment history, or if some older periods were empty. You can always load the partial file. |
| Download does not start automatically | Click the **Download JSON** button in the panel manually. |

---

## Self-Hosting (for IT / firm-wide deployment)

If your firm wants to host this tool internally (for example, to ensure the
script is served from a trusted internal domain):

1. Copy `extract.js` to any web server your staff can reach — for example,
   an internal SharePoint site, an IIS static-files folder, or a company
   GitHub Pages site.

2. Update the bookmarklet URL by replacing `https://lmnts.github.io/retrospectacles` with the
   internal URL where `extract.js` is hosted.

3. Distribute the updated bookmarklet URL to staff via your normal IT
   communication channel.

No other configuration is required. The script has no dependencies and does
not need a build step.
