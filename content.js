// Injected on Ramp's "My expenses" page. Scans the expense table for rows
// missing a memo and/or a receipt, independent of the Policy status column
// (which reflects policy compliance, not whether a memo/receipt exists).

(() => {
  if (window.__rampExpenseFlaggerInjected) return;
  window.__rampExpenseFlaggerInjected = true;

  const RANGE_OPTIONS = [
    { label: 'Last 1 month', months: 1 },
    { label: 'Last 2 months', months: 2 },
    { label: 'Last 3 months', months: 3 },
    { label: 'All expenses', months: null },
  ];
  const DEFAULT_MONTHS = 2;

  let state = freshState(DEFAULT_MONTHS);

  function freshState(months) {
    return {
      status: 'idle', // idle | scanning | needs-next-page | done | error
      months,
      cutoffDate: months ? monthsAgo(months) : null,
      rangeLabel: RANGE_OPTIONS.find((r) => r.months === months)?.label || 'All expenses',
      seenHrefs: new Set(),
      flagged: [], // { href, merchant, dateLabel, amount, missingMemo, missingReceipt }
      selected: new Set(),
      scannedCount: 0,
      error: null,
      memoDrafts: new Map(), // href -> in-progress input text
      memoStatus: new Map(), // href -> 'saving' | 'error'
    };
  }

  function monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Every href here is scraped from Ramp's own DOM and should already be an
  // app.ramp.com URL, but re-validate before ever rendering it as a link or
  // handing it to chrome.tabs.create — defense in depth against a
  // compromised-page scenario forging a javascript:/data: URL.
  function isSafeRampUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'app.ramp.com';
    } catch (e) {
      return false;
    }
  }

  // ---------- Table reading ----------

  function getTable() {
    return document.querySelector('table');
  }

  function getColumnIndexes(table) {
    const headerCells = Array.from(table.querySelectorAll('thead th'));
    // Sample a genuine expense row (one with a detail link), not whichever
    // <tr> happens to be first — some views interleave non-data rows (e.g.
    // group/section dividers) that would otherwise throw the offset off.
    const dataRow = Array.from(table.querySelectorAll('tbody tr')).find((tr) =>
      tr.querySelector('a[href*="/details/"]')
    );
    const offset = dataRow
      ? Math.max(0, dataRow.querySelectorAll('td').length - headerCells.length)
      : 0;
    const idx = {};
    headerCells.forEach((th, i) => {
      const text = th.textContent.trim().toLowerCase();
      if (text) idx[text] = i + offset;
    });
    return idx;
  }

  function cellAt(tr, colIndex) {
    if (!tr || colIndex === undefined) return null;
    return tr.querySelectorAll('td')[colIndex] || null;
  }

  function firstTextNode(el) {
    if (!el) return '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    return node ? node.textContent.trim() : el.textContent.trim();
  }

  // Ramp renders receipt status as an icon whose class encodes the state:
  // "receipt-check" (manually uploaded/verified) or "receipt-auto" (Ramp
  // auto-generated one from transaction metadata, e.g. SaaS subscriptions)
  // both mean a receipt exists; anything else (e.g. "minus", for "not
  // required") does not. Reimbursement rows don't get a clickable "View
  // receipt" link even when a receipt is attached, so the icon is the only
  // reliable signal there; card-transaction rows show both, and auto-generated
  // ones are only reliably signaled by the "View receipt" text (their icon
  // class differs from "receipt-check") — so a row counts as having a
  // receipt if EITHER signal says so.
  function hasReceiptSignal(tr) {
    const iconPresent = Array.from(tr.querySelectorAll('svg')).some((svg) =>
      /RyuIconSvg--receipt-(check|auto)\b/.test(svg.getAttribute('class') || '')
    );
    return iconPresent || tr.textContent.includes('View receipt');
  }

  function parseRow(tr, colIdx) {
    const a = tr.querySelector('a[href*="/details/"]');
    if (!a) return null;
    const href = new URL(a.getAttribute('href'), location.origin).href;
    if (!isSafeRampUrl(href)) return null;
    const merchant = firstTextNode(cellAt(tr, colIdx['merchant'])) || 'Unknown merchant';
    const dateLabel = cellAt(tr, colIdx['transaction date'])?.textContent.trim() || '';
    const amount = cellAt(tr, colIdx['amount'])?.textContent.trim() || '';
    const memoText = cellAt(tr, colIdx['memo'])?.textContent.trim() || '';
    const missingMemo = /^[\s\-–—−]*$/.test(memoText);
    const missingReceipt = !hasReceiptSignal(tr);
    const date = new Date(dateLabel);
    return { href, merchant, dateLabel, date, amount, missingMemo, missingReceipt };
  }

  async function collectCurrentPageRows() {
    const table = getTable();
    if (!table) throw new Error('NO_TABLE');
    const colIdx = getColumnIndexes(table);
    if (!('memo' in colIdx) || !('transaction date' in colIdx)) throw new Error('NO_COLUMNS');

    const rowsByHref = new Map();
    const collect = () => {
      table.querySelectorAll('tbody tr').forEach((tr) => {
        const row = parseRow(tr, colIdx);
        if (row) rowsByHref.set(row.href, row);
      });
    };

    window.scrollTo(0, 0);
    await wait(250);
    collect();

    let lastY = -1;
    for (let step = 0; step < 60; step++) {
      collect();
      window.scrollBy(0, 350);
      await wait(180);
      collect();
      if (window.scrollY === lastY) break;
      lastY = window.scrollY;
    }
    collect();
    return Array.from(rowsByHref.values());
  }

  function getPaginationButton() {
    return (
      Array.from(document.querySelectorAll('button[aria-label^="Next "]')).find(
        (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      ) || null
    );
  }

  // ---------- Scan orchestration ----------

  async function runScanStep() {
    state.status = 'scanning';
    state.error = null;
    render();

    let rows;
    try {
      rows = await collectCurrentPageRows();
    } catch (e) {
      state.status = 'error';
      state.error =
        e.message === 'NO_COLUMNS'
          ? 'Could not find the Memo / Transaction date columns on this page.'
          : 'Could not find the expense table on this page.';
      try {
        chrome.runtime.sendMessage({ type: 'SCAN_ERROR' });
      } catch (sendError) {
        // Extension context invalidated — nothing to recover to.
      }
      render();
      return;
    }

    let oldestOnPage = null;
    for (const row of rows) {
      if (state.seenHrefs.has(row.href)) continue;
      state.seenHrefs.add(row.href);
      state.scannedCount++;
      if (!isNaN(row.date)) {
        if (!oldestOnPage || row.date < oldestOnPage) oldestOnPage = row.date;
      }
      if (state.cutoffDate && !isNaN(row.date) && row.date < state.cutoffDate) continue;
      if (row.missingMemo || row.missingReceipt) {
        state.flagged.push(row);
        state.selected.add(row.href);
      }
    }

    const withinWindow = !state.cutoffDate || !oldestOnPage || oldestOnPage >= state.cutoffDate;
    const nextButton = getPaginationButton();

    if (withinWindow && nextButton) {
      state.status = 'needs-next-page';
    } else {
      state.status = 'done';
      reportToBackground();
    }
    render();
  }

  function reportToBackground() {
    try {
      chrome.runtime.sendMessage({
        type: 'SCAN_RESULT',
        payload: {
          scannedAt: Date.now(),
          rangeLabel: state.rangeLabel,
          scannedCount: state.scannedCount,
          flagged: state.flagged.map(serializeRow),
        },
      });
    } catch (e) {
      // Extension context invalidated (e.g. reloaded while this tab stayed
      // open) — the scan itself still succeeded, only the badge/popup mirror
      // didn't update, so don't let this stall the in-page panel.
    }
  }

  function serializeRow(row) {
    return {
      href: row.href,
      merchant: row.merchant,
      dateLabel: row.dateLabel,
      amount: row.amount,
      missingMemo: row.missingMemo,
      missingReceipt: row.missingReceipt,
    };
  }

  function startScan(months) {
    if (state.status === 'scanning') return; // a scan is already in flight — ignore
    state = freshState(months);
    runScanStep();
  }

  function openSelected() {
    const urls = state.flagged.filter((r) => state.selected.has(r.href)).map((r) => r.href);
    if (!urls.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'OPEN_TABS', payload: { urls } });
    } catch (e) {
      // Extension context invalidated — nothing to recover to; the user can
      // still use the per-row "open" links, which are plain <a> tags.
    }
  }

  // ---------- Writing a memo directly from the panel ----------
  // Ramp's list table has its own inline-editable memo cell (a click on the
  // cell's "EditableRoot" wrapper reveals a real <textarea>, and blurring it
  // saves) — confirmed to accept fully synthetic clicks/blur, unlike the
  // pagination button. So this happens entirely on the current page, no
  // navigation or background tab needed. A receipt can't be filled this way
  // — it needs an actual file — so this only applies to missingMemo.

  async function pollFor(findFn, timeoutMs, stepMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = findFn();
      if (found) return found;
      await wait(stepMs);
    }
    return null;
  }

  function findRowElementByHref(href) {
    return (
      Array.from(document.querySelectorAll('a[href*="/details/"]')).find(
        (a) => a.href === href
      )?.closest('tr') || null
    );
  }

  async function scrollUntilRowFound(href) {
    let tr = findRowElementByHref(href);
    if (tr) return tr;
    window.scrollTo(0, 0);
    await wait(200);
    let lastY = -1;
    for (let step = 0; step < 60 && !tr; step++) {
      tr = findRowElementByHref(href);
      if (tr) break;
      window.scrollBy(0, 350);
      await wait(150);
      if (window.scrollY === lastY) break; // reached the bottom — not on this page
      lastY = window.scrollY;
    }
    return tr;
  }

  async function writeMemoInline(row, text) {
    const tr = await scrollUntilRowFound(row.href);
    if (!tr) return false;

    const table = getTable();
    const colIdx = table ? getColumnIndexes(table) : {};
    if (!('memo' in colIdx)) return false;

    tr.scrollIntoView({ block: 'center' });
    tr.classList.add('ramp-flagger-highlight');
    await wait(150);

    try {
      const memoCell = cellAt(tr, colIdx['memo']);
      if (!memoCell) return false;
      const editableRoot = memoCell.querySelector('[class*="EditableRoot"]') || memoCell;
      editableRoot.click();

      const textarea = await pollFor(
        () => document.querySelector('textarea[placeholder="Memo"]'),
        3000,
        150
      );
      if (!textarea) return false;

      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      ).set;
      nativeSetter.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(250);
      textarea.blur();

      const saved = await pollFor(() => {
        if (document.querySelector('textarea[placeholder="Memo"]')) return null;
        const freshCell = cellAt(findRowElementByHref(row.href), colIdx['memo']);
        return freshCell && freshCell.textContent.trim() === text ? true : null;
      }, 10000, 250);

      return !!saved;
    } finally {
      tr.classList.remove('ramp-flagger-highlight');
    }
  }

  async function submitMemo(row, text) {
    const trimmed = text.trim();
    if (!trimmed || state.memoStatus.get(row.href) === 'saving') return;

    state.memoStatus.set(row.href, 'saving');
    render();

    const ok = await writeMemoInline(row, trimmed);

    if (ok) {
      state.memoStatus.delete(row.href);
      state.memoDrafts.delete(row.href);
      row.missingMemo = false;
      if (!row.missingReceipt) {
        state.flagged = state.flagged.filter((r) => r.href !== row.href);
        state.selected.delete(row.href);
      }
      reportToBackground();
    } else {
      state.memoStatus.set(row.href, 'error');
    }
    render();
  }

  function buildMemoForm(row) {
    const status = state.memoStatus.get(row.href);
    const saving = status === 'saving';

    const form = document.createElement('div');
    form.className = 'ramp-flagger-memo-form';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Add memo…';
    input.value = state.memoDrafts.get(row.href) ?? '';
    input.className = 'ramp-flagger-memo-input';
    input.disabled = saving;
    input.setAttribute('aria-label', `Memo for ${row.merchant}`);
    input.addEventListener('input', () => state.memoDrafts.set(row.href, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitMemo(row, input.value);
      }
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'ramp-flagger-memo-save';
    saveBtn.textContent = saving ? 'Saving…' : 'Save';
    saveBtn.disabled = saving;
    saveBtn.addEventListener('click', () => submitMemo(row, input.value));

    form.appendChild(input);
    form.appendChild(saveBtn);

    if (status === 'error') {
      const err = document.createElement('div');
      err.className = 'ramp-flagger-memo-error';
      err.textContent = "Couldn't save that memo to Ramp — try again.";
      form.appendChild(err);
    }

    return form;
  }

  // ---------- UI ----------

  let root, toggleBtn, panel;

  function buildShell() {
    root = document.createElement('div');
    root.id = 'ramp-flagger-root';

    toggleBtn = document.createElement('button');
    toggleBtn.id = 'ramp-flagger-toggle';
    toggleBtn.textContent = 'Missing memo/receipt';
    toggleBtn.addEventListener('click', () => {
      const wasOpen = panel.classList.contains('ramp-flagger-open');
      panel.classList.toggle('ramp-flagger-open');
      const isOpen = panel.classList.contains('ramp-flagger-open');
      const neverScanned = state.status === 'idle' && state.scannedCount === 0;
      if (isOpen && !wasOpen && neverScanned) {
        startScan(state.months);
      }
    });

    panel = document.createElement('div');
    panel.id = 'ramp-flagger-panel';

    root.appendChild(panel);
    root.appendChild(toggleBtn);
    document.body.appendChild(root);
    render();
  }

  function render() {
    if (!panel) return;
    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'ramp-flagger-header';
    header.innerHTML = '<strong>Ramp Flagger</strong>';
    panel.appendChild(header);

    const controls = document.createElement('div');
    controls.className = 'ramp-flagger-controls';

    const select = document.createElement('select');
    RANGE_OPTIONS.forEach((opt) => {
      const o = document.createElement('option');
      o.value = String(opt.months);
      o.textContent = opt.label;
      if (opt.months === state.months) o.selected = true;
      select.appendChild(o);
    });
    select.disabled = state.status === 'scanning';
    select.setAttribute('aria-label', 'Scan date range');
    select.addEventListener('change', () => {
      const v = select.value;
      startScan(v === 'null' ? null : Number(v));
    });

    const scanBtn = document.createElement('button');
    scanBtn.className = 'ramp-flagger-primary';
    scanBtn.textContent =
      state.status === 'scanning'
        ? 'Scanning…'
        : state.status === 'idle'
        ? 'Scan'
        : 'Rescan';
    scanBtn.disabled = state.status === 'scanning';
    scanBtn.addEventListener('click', () => startScan(state.months));

    controls.appendChild(select);
    controls.appendChild(scanBtn);
    panel.appendChild(controls);

    const status = document.createElement('div');
    status.className = 'ramp-flagger-status';
    if (state.status === 'error') {
      status.textContent = state.error;
      status.classList.add('ramp-flagger-error');
    } else if (state.status === 'needs-next-page') {
      status.innerHTML =
        `Read ${state.scannedCount} expenses so far, ${state.flagged.length} flagged. ` +
        'More pages are within range. If this panel covers Ramp\'s pagination control, ' +
        "click the floating button below to close the panel, click that control, then " +
        'reopen this panel and click "Continue scan".';
    } else if (state.status === 'done') {
      status.textContent = `Scanned ${state.scannedCount} expenses (${state.rangeLabel.toLowerCase()}). ${state.flagged.length} flagged.`;
    } else if (state.status === 'scanning') {
      status.textContent = 'Scanning current page… (the page will auto-scroll — that’s expected.)';
    } else {
      status.textContent = 'Pick a range and click Scan.';
    }
    panel.appendChild(status);

    if (state.status === 'needs-next-page') {
      const continueBtn = document.createElement('button');
      continueBtn.className = 'ramp-flagger-primary';
      continueBtn.textContent = 'Continue scan';
      continueBtn.addEventListener('click', () => runScanStep());
      panel.appendChild(continueBtn);
    }

    if (state.flagged.length) {
      const list = document.createElement('div');
      list.className = 'ramp-flagger-list';
      state.flagged.forEach((row) => {
        const item = document.createElement('div');
        item.className = 'ramp-flagger-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.selected.has(row.href);
        cb.addEventListener('change', () => {
          if (cb.checked) state.selected.add(row.href);
          else state.selected.delete(row.href);
          renderOpenButtonCount();
        });

        const tags = [];
        if (row.missingMemo) tags.push('no memo');
        if (row.missingReceipt) tags.push('no receipt');

        const text = document.createElement('span');
        text.innerHTML =
          `<span class="ramp-flagger-merchant">${escapeHtml(row.merchant)}</span>` +
          `<span class="ramp-flagger-meta">${escapeHtml(row.dateLabel)} · ${escapeHtml(row.amount)} · ` +
          `<span class="ramp-flagger-tags">${tags.join(', ')}</span></span>`;

        const link = document.createElement('a');
        link.href = row.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'ramp-flagger-open-one';
        link.textContent = 'open';
        link.setAttribute('aria-label', `Open ${row.merchant} expense`);

        // Clicking anywhere in the row toggles its checkbox, except the
        // "open" link and the inline memo form (which need their own
        // default click/typing behavior).
        item.addEventListener('click', (e) => {
          if (e.target === cb || e.target === link) return;
          if (e.target.closest('.ramp-flagger-memo-form')) return;
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event('change'));
        });

        item.appendChild(cb);
        item.appendChild(text);
        item.appendChild(link);

        if (row.missingMemo) {
          item.appendChild(buildMemoForm(row));
        }

        list.appendChild(item);
      });
      panel.appendChild(list);

      const openBtn = document.createElement('button');
      openBtn.id = 'ramp-flagger-open-selected';
      openBtn.className = 'ramp-flagger-primary';
      openBtn.addEventListener('click', openSelected);
      panel.appendChild(openBtn);
      renderOpenButtonCount();
    } else if (state.status === 'done') {
      const empty = document.createElement('div');
      empty.className = 'ramp-flagger-empty';
      empty.textContent = "Nothing flagged — you're all set for this range.";
      panel.appendChild(empty);
    }

    toggleBtn.textContent = state.flagged.length
      ? `⚠ ${state.flagged.length} flagged`
      : 'Missing memo/receipt';
    toggleBtn.classList.toggle('ramp-flagger-has-flags', state.flagged.length > 0);
  }

  function renderOpenButtonCount() {
    const btn = document.getElementById('ramp-flagger-open-selected');
    if (!btn) return;
    btn.textContent = `Open ${state.selected.size} selected in new tabs`;
    btn.disabled = state.selected.size === 0;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RESCAN') {
      panel.classList.add('ramp-flagger-open');
      startScan(state.months);
    }
  });

  buildShell();
})();
