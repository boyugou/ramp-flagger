# Ramp Flagger

A Manifest V3 Chrome extension, plain JS/CSS/HTML with no build step and no runtime
dependencies. It injects a content script into Ramp's "My expenses" page
(`https://app.ramp.com/home/personal-expenses/all`), scrapes the expense table, flags rows
missing a memo and/or a receipt, and can write a missing memo directly from its panel (the
only write this tool ever performs — everything else, including receipts, is read-only).

## Layout

- `manifest.json` — permissions and content-script registration.
- `content.js` / `content.css` — injected across Ramp's `/home` section; mounts the floating
  in-page panel only while the URL is the expenses page (see "SPA-aware mounting" below), and
  does the table scraping, pagination handling, and memo writing there.
- `background.js` — service worker: persists the last scan to `chrome.storage.local`,
  updates the toolbar badge, and is the only place a scraped URL is passed to
  `chrome.tabs.create` (after validating its scheme/host). Writing a memo doesn't involve
  background.js at all — see "Writing a memo" below.
- `popup/` — toolbar popup; renders the same last-scan data from storage.
- `scripts/generate_icons.py` — regenerates `icons/icon-{16,32,48,128}.png` from one vector
  drawing. Run with `uv run --with pillow scripts/generate_icons.py`.
- `docs/superpowers/specs/` — dated design docs from when features were designed. Reference
  material for historical rationale, not a source of truth for current behavior — if code
  and a spec ever disagree, the code (and this file) win.

## Ramp table ground truth (read this before touching the scraping logic)

The expense table has no documented API; everything is read from the rendered DOM. Column
order is resolved by header name (case-insensitive `<thead th>` text), not a hardcoded
index, because the table's rows carry one extra leading `<td>` (a hidden row-handle anchor)
that the header row doesn't have — `getColumnIndexes` in `content.js` derives that offset
from an actual data row (one with a `/details/` link), not blindly the first `tbody tr`,
since some views interleave non-data rows.

**Memo** is read directly from the Memo column's cell text; it counts as missing only if
that text is empty or entirely whitespace/dash characters (`-`, `–`, `—`, `−`).

**Receipt** presence cannot be determined from any single signal in isolation — each of the
three signals below is the *only* one present for at least one common row type:

- A `<svg>` with a class containing `RyuIconSvg--receipt-check` means a receipt was
  manually uploaded or verified.
- A `<svg>` with class `RyuIconSvg--receipt-auto` means Ramp auto-generated a receipt from
  transaction metadata (common for SaaS-subscription card charges) — this is a *different*
  icon from `receipt-check`, and represents an equally valid "receipt present" state.
- A "View receipt" text link in the row is a third, independent positive signal: it appears
  on card-transaction rows regardless of icon, but reimbursement-type rows never render it
  even when they do have a verified receipt attached — confirmed by cross-checking against
  Ramp's separate "Reimbursements" tab and against individual expense detail pages.

A row counts as having a receipt if *any* of the three signals is present; it's flagged as
missing only if *none* are. Do not simplify this back down to a single check — each of the
three known cases (uploaded, auto-generated, reimbursement-verified) is only caught by one
of the three signals.

None of this is exposed via Ramp's own "Policy status" icons, which reflect policy
*compliance* (e.g. "receipt not required for this category") rather than literal presence —
that distinction is the entire reason this tool exists instead of just reading that column.

The table virtualizes rendering (only a subset of a page's rows exist in the DOM at once,
recycled as the page scrolls) and paginates at 50 rows via a control matched by
`button[aria-label^="Next "]`. Reading a full page requires scrolling in small increments
and accumulating rows by href (`collectCurrentPageRows`) rather than jumping straight to the
bottom. Advancing past 50 rows needs a real user click — Ramp's pagination button does not
respond to a content script's synthetic `click`/`pointer*` events (verified against the live
page), so the panel asks the user to click it manually rather than requesting the
`chrome.debugger` permission to fake a trusted click.

## Writing a memo (content.js's writeMemoInline)

The expense list's own Memo `<td>` is inline-editable in place — no navigation, no detail
page involved. Clicking directly on the cell's rendered text (or, for a blank cell, the `—`
placeholder) reveals a real `<textarea placeholder="Memo">`, and blurring it saves
immediately, with no separate "Save" button. The catch: the click must land on the cell's
`[class*="EditableRoot"]`-classed child specifically — clicking the `<td>` itself, or
anywhere else in the row, does nothing (blank cell) or navigates to the detail page (any
other column), because the whole row doubles as a link. Every step responds to fully
synthetic interaction, confirmed empirically:

- A synthetic `.click()` on the `EditableRoot` element reveals the textarea.
- Setting its value must go through the native setter — `Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, text)` — followed by
  dispatching a bubbling `new Event('input')`. A direct `textarea.value = text` assignment
  does not update React's internal tracked value, so the field would silently keep showing
  the old text even though the DOM property changed. This is a standard React-controlled-
  input quirk, unrelated to the pagination button's trusted-click requirement.
- A synthetic `.blur()` on the textarea (no click elsewhere needed) commits the save and
  persists to Ramp's backend (confirmed by reloading the page and seeing the memo still
  there).

`writeMemoInline` in `content.js` does the whole thing on the current page: re-locate the
target row by href (it may have scrolled out of the virtualized table since it was
flagged — reuses the same scroll-accumulate technique as scanning), click the `EditableRoot`,
poll for the textarea to appear (don't assume a fixed delay — see the pagination note above
for why Ramp's SPA timing can't be assumed), set the value, blur, then poll again for the
textarea to disappear *and* the cell's displayed text to match what was typed, before
declaring success. Checking only "the textarea disappeared" is not sufficient — that can
happen slightly before the display re-renders the saved text, producing a false negative if
the timeout is too tight; this was hit empirically once (10s timeout is what's used now,
after 4s proved too short).

## SPA-aware mounting (read this before touching the manifest match pattern)

Ramp is a client-side-routed single-page app. A content script declared in the manifest is
injected only on a *real document load* whose URL matches — it is **not** re-injected when
the app changes the URL via `history.pushState`. So if the match pattern were scoped only to
`.../personal-expenses/all`, arriving there by clicking through Ramp's own nav from the
homepage (a pushState route change, no document load) would never inject the script, and the
floating panel would silently never appear. Landing there via a pasted URL / reload *would*
work — which is exactly the confusing split that was reported.

The fix: the content script matches Ramp's whole `/home` section (`/home` and `/home/*`),
which is where users land and where "My expenses" lives, so it's already present in the
document before any in-app navigation. It then mounts/unmounts its own UI based on
`location.pathname` (`mountIfNeeded`), re-checking on every route change.

Route changes are detected by **polling `location.href` every 500ms** plus a `popstate`
listener — *not* by patching `history.pushState`. A content script runs in an isolated JS
world with its own `window`/`history` binding, so patching `pushState` there would not
intercept the page's own (main-world) calls. Polling `location` works because `location`
reflects the shared document URL across worlds.

If you ever need the panel to also appear when navigating in from *outside* `/home` (e.g.
straight from Vendors or Cards without a reload), widen the match to
`https://app.ramp.com/*`; the mounting logic already gates on pathname, so nothing else
changes. It's left at `/home*` to keep the injected surface — and the install-time
permission prompt — as narrow as still fixes the reported flow.

## Permissions philosophy

`manifest.json` requests only `"storage"` (for persisting the last scan result). The
content script matches Ramp's `/home` section (`/home` + `/home/*`) — as narrow as the
SPA-mounting fix allows (see above), not all of `app.ramp.com`. `host_permissions` stays
scoped to `https://app.ramp.com/home/personal-expenses/all*`, needed only for the popup's
`chrome.tabs.query({url})`; it deliberately isn't widened to the `/home` section because
nothing programmatic queries those other URLs. No `"scripting"` permission (writing a memo
never leaves the current page, so there's nothing to inject into another tab) and no
`"tabs"` permission (creating/updating/messaging tabs doesn't require it; the host
permission already covers every URL ever queried). Any scraped `href` is
re-validated (`protocol === 'https:' && hostname === 'app.ramp.com'`) in both
`background.js` and `popup.js` immediately before it's passed to `chrome.tabs.create`, even
though it originates from Ramp's own DOM — defense in depth against a compromised-page
scenario using the bulk "open selected" action to open attacker-chosen tabs. Keep new
permissions this narrow; widen only when a concrete feature needs it.

## Testing

No automated test suite — there's no way to run Ramp's SPA outside a real logged-in
session. Verify scraping-logic changes by loading the unpacked extension against a live
account and checking specific rows against their detail pages (open a row that should have
a receipt, confirm the "Receipt" field on the detail page agrees with what the panel
flagged). When in doubt about an icon class or DOM shape, inspect the live page directly
rather than inferring from a screenshot or from a single row — the receipt ground-truth
rules above only hold because each of the three row types (card transaction, reimbursement,
auto-generated receipt) was individually checked against its own detail page.

For `writeMemoInline` changes specifically: verify by clearing a real expense's memo, running
the panel's write-memo flow, then reloading the list (or detail) page directly — confirm the
memo persisted. A success reading from the panel's own local state isn't sufficient proof
the write actually reached Ramp.
