# Ramp Flagger — Design

## Problem

Ramp's "My expenses" page (`https://app.ramp.com/home/personal-expenses/all`) lists every
personal expense with a "Policy status" column of icons. Those icons reflect policy
*compliance*, not whether a memo or receipt actually exists — an expense whose policy says
"receipt not required" still renders as compliant even with zero receipt attached. There is
no built-in way to ask "which of my recent expenses are missing a memo or a receipt,
regardless of what the policy requires."

## Goal

A Chrome extension that, on demand, scans the expense table, determines for each row
whether it has a memo and whether it has a receipt (ground truth, independent of policy
requirement), lets the user write a missing memo directly from the panel, and lets the user
jump straight to the remaining flagged expenses (receipts still require Ramp's own detail
page, since they need an actual file).

## Ground-truth signals (validated against the live page)

The expense table is a plain HTML `<table>` with explicit column headers (Merchant,
Transaction date, Payment type, Status, Charge status, Spent from, Memo, Policy status,
Trip, Amount). Two signals are read directly from the DOM, not inferred from icons:

- **Memo present** — the Memo `<td>`'s text is non-empty once whitespace and dash-like
  placeholder characters (`-`, `–`, `—`, `−`) are stripped. Auto-generated memos (e.g. a
  recurring subscription's default memo) count as present, matching the user's stated rule.
- **Receipt present** — an icon whose class contains `RyuIconSvg--receipt-check` (manually
  uploaded/verified) or `RyuIconSvg--receipt-auto` (Ramp auto-generated one from transaction
  metadata) anywhere in the row, OR the row contains a "View receipt" link. All three are
  independent of the Policy status icons — a row can show a compliant policy icon while
  having none of these, and that still counts as receipt-missing.

  A single signal is not enough on its own: reimbursement-type rows never render a "View
  receipt" link even when a receipt is attached (verified against the live account — every
  reimbursement that had one showed no such link), so text-only detection produced false
  positives on 100% of them. Conversely, card-transaction rows with an auto-generated
  receipt (e.g. SaaS subscriptions) render the "View receipt" link but use the
  `receipt-auto` icon class rather than `receipt-check`, so icon-only detection (checking
  for `receipt-check` alone) produced a false positive there. Checking for either icon
  class OR the text link covers all three cases actually observed.

Each row also carries a detail-page link (`/details/transactions/<uuid>` or
`/details/reimbursements/<uuid>`) usable to jump straight to that expense.

The table virtualizes rendering (only a subset of a page's rows exist in the DOM at once,
recycled as the page scrolls) and paginates at 50 rows per page via a "next page" control.
A scan force-renders every row of the currently-loaded page by scrolling in small
increments and accumulating rows by href (a single jump to the bottom is not enough — rows
scrolled past get unmounted). Reading beyond 50 rows requires advancing to the next page,
but Ramp's pagination button only responds to a genuinely trusted click — a content script
dispatching synthetic `click`/`pointer*` events on it (even a full pointerdown/up/click
sequence) has no effect, confirmed empirically against the live page. A content script
cannot fabricate a trusted event, so auto-pagination is not possible without the
`chrome.debugger` permission (which shows a persistent "this extension is debugging your
browser" banner for as long as it's attached). The extension instead scans exactly what's
loaded and, if the selected window isn't fully covered yet, asks the user to click Ramp's
own "→" control once and then click "Continue scan" — full automation within a page, one
manual click per additional 50 rows.

## Writing a memo directly from the panel

The expense list's own Memo cell is inline-editable — clicking directly on its text (or,
for a blank cell, the `—` placeholder) reveals a real `<textarea placeholder="Memo">` in
place, and blurring it saves, with no separate "Save" button and no navigation away from
the list. This is easy to miss by clicking slightly the wrong spot (the row is otherwise a
giant link to the detail page — clicking anywhere in the row *except* precisely on the
memo cell's editable wrapper navigates there instead, which is what earlier testing had
concluded, incorrectly, before this was found by clicking exactly on the cell's rendered
text). Confirmed empirically, and unlike the pagination button, every step responds to
fully synthetic interaction:

- A synthetic `.click()` on the memo cell's `[class*="EditableRoot"]`-classed child (not
  the `<td>` itself, which does nothing) reveals the textarea.
- Setting its value requires the native-setter trick (`Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype, 'value').set.call(textarea, text)` followed by dispatching
  a bubbling `input` event) rather than assigning `.value` directly, because the field is a
  React-controlled input — a direct assignment doesn't update React's internal value
  tracking, so the UI silently keeps the old value. The native-setter dispatch does update
  it correctly.
- A synthetic `.blur()` on the textarea (no click elsewhere needed) commits the save and
  persists to Ramp's backend — verified by reloading the page afterward and seeing the memo
  still there.

Because this all happens on the same list page the content script already runs on, no
background tab, no `chrome.scripting`, and no extra host permission are needed — writing a
memo is implemented entirely in `content.js`. The row being written to may have scrolled out
of the table's virtualized DOM since it was flagged, so the same scroll-accumulate technique
used for scanning re-locates it by href first.

## Non-goals (v1)

- No automatic/background scanning — scan is user-triggered.
- No persistent "ignore this expense" list — every scan is a fresh, complete read of the
  current page state.
- No support for team/admin expense-report views, or Ramp's separate "Reimbursements"
  sub-tab — only the combined "All" personal-expenses view. The Reimbursements sub-tab
  renders a structurally different table (different column set and order, with
  section-divider rows interleaved), which this tool's column-mapping isn't built for.
- The only write this tool performs is filling in a missing memo (see "Writing a memo"
  below); it never modifies any other field, and never touches receipts (those need an
  actual file, so they always go through Ramp's own detail page).

## Architecture

Manifest V3 extension, following the existing project convention seen in
`development/safari_extensions/*` (content script + service worker + popup, one icon set,
one README per extension):

```
ramp-expense-flagger/
├── manifest.json
├── content.js       injected on https://app.ramp.com/home/personal-expenses/all*
├── background.js    service worker: persists scan results, updates the toolbar badge
├── popup/
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── icons/            16/32/48/128 px
└── README.md
```

### Data flow

1. `content.js` injects a floating toggle button on the expenses page as soon as it matches
   the URL. The first time it's opened (no scan has run yet), it immediately starts a scan
   at the default range (trailing 2 months); a date-range dropdown (1/2/3 months / all) and
   a "Rescan" button inside the panel let the user re-run it at a different range.
2. Each scan step force-renders and reads the currently-loaded page (scroll-accumulate by
   href), recording each row's date, merchant, memo-present, receipt-present, and detail URL.
   If rows within the selected window remain on a further page, the panel prompts the user
   to click Ramp's own pagination arrow and then "Continue scan" (see the pagination note
   above for why this step can't be automated).
3. Rows missing a memo and/or a receipt are collected into a flat list and rendered in the
   panel (checkbox per row, defaulted checked), with an "Open selected in new tabs" button
   that opens each row's detail URL directly.
4. Each memo-flagged row in the panel gets its own inline text input and "Save" button (see
   "Writing a memo directly from the panel" below) — submitting locates the row in the live
   table (re-locating it by href if it's scrolled out of the virtualized DOM), drives Ramp's
   own inline memo cell directly, and on success clears that row's memo-missing flag locally
   (dropping the row entirely if it wasn't also missing a receipt) without a full rescan.
5. The flagged-result list, plus the date range and a timestamp, is sent via
   `chrome.runtime.sendMessage` to `background.js`, which writes it to
   `chrome.storage.local` and sets the toolbar badge text to the flagged count.
6. `popup.js` reads the same `chrome.storage.local` entry to render an identical list (no
   re-scan needed to view it) with its own checkbox selection and "open selected" action.
   If a Ramp expenses tab is open, the popup offers a "Rescan" button that messages that
   tab's content script to re-run steps 1–4; otherwise it offers an "Open my expenses"
   button that creates/activates that tab.

### Error handling

- If the table structure isn't found (selector miss, e.g. Ramp changed markup), the content
  script surfaces an inline error in its panel ("couldn't read the expense table") rather
  than silently returning zero results — a silent zero would be indistinguishable from
  "nothing flagged."
- If the pagination control disappears or reports disabled once the user has clicked it, the
  scan step re-reads whatever is currently loaded rather than looping — it can't distinguish
  "no more pages" from "still loading," so a stuck "Continue scan" simply re-scans the same
  page harmlessly (rows are deduplicated by href, so nothing double-counts).
- Popup gracefully handles "no scan yet" (empty storage) by prompting the user to open the
  expenses page and scan.
- `startScan` no-ops if a scan is already in flight (`state.status === 'scanning'`), so a
  rescan triggered from the popup while an in-page scan is still running can't reassign the
  shared `state` object out from under the running scan.
- Every `chrome.runtime.sendMessage` call from the content script is wrapped in try/catch —
  if the extension is reloaded while a scan tab stays open, the in-flight scan still
  completes and renders locally; only the badge/popup mirror misses that update, rather
  than the whole in-page panel getting stuck mid-scan with no way to recover short of a
  reload.
- A scan that errors out sends a `SCAN_ERROR` message so the toolbar badge switches to a
  neutral "stale" indicator (`!`, gray) instead of continuing to show the last successful
  count as if it were still current.
- `background.js` and `popup.js` both re-validate that a URL is `https://app.ramp.com/...`
  before ever calling `chrome.tabs.create` with it, even though the value already came from
  Ramp's own rendered DOM — defense in depth against a same-origin XSS/compromise scenario
  being able to use the "open selected" bulk action to silently open attacker-chosen tabs.
- A memo write fails safe at any step (row not found even after scrolling, editable wrapper
  or textarea never appears, or the displayed cell text never matches what was typed after
  blurring) — `writeMemoInline` returns `false` rather than throwing, the row's transient
  highlight is always removed in a `finally` block, and the panel shows a per-row error with
  the typed text preserved so the user can retry without retyping.

## UI/UX and icon design

A floating pill button (bottom-right of the page, raised above the typical support-chat-
launcher slot) that reads "Missing memo/receipt" until a scan has run, then shows a live
"⚠ N flagged" count in a warm accent color (darkened to `#b8430d` so white-on-accent and
accent-on-card text both clear WCAG AA contrast). Clicking
it opens a card-style panel — visually distinct from Ramp's own UI so it reads unambiguously
as a third-party overlay, not a native Ramp feature. Each memo-flagged row carries its own
inline text input and Save button. The popup (toolbar icon) mirrors the scan-result list and
styling for access without the Ramp tab in focus, but not the inline memo-write form — that
currently lives only in the in-page panel. The icon is a receipt silhouette with a
magnifying glass and an orange alert badge, rendered at 16/32/48/128px.

## Testing plan

- Validate the scan/parse logic directly against the live Ramp page (via manual DOM
  inspection) before wiring it into `content.js`, covering: rows with memo+receipt, memo
  only, receipt only, neither, and reimbursement-type rows.
- Manual end-to-end pass after loading the unpacked extension: trigger a scan, confirm the
  flagged list matches manual inspection of the visible rows, confirm badge count matches,
  confirm popup mirrors the in-page results, confirm "open selected" opens the correct
  detail URLs in new tabs.
- For the memo-write path specifically: clear a real expense's memo, confirm the panel
  flags it, type a memo and save from the panel, then reload the list page (or the
  expense's detail page) and confirm the memo persisted — not just that the panel's local
  state looked successful.
