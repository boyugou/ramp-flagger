const RAMP_URL_PATTERN = 'https://app.ramp.com/home/personal-expenses/all*';
const RAMP_DEFAULT_URL = 'https://app.ramp.com/home/personal-expenses/all';
const ALLOWED_HOST = 'app.ramp.com';

let flagged = [];
let selected = new Set();

function isSafeRampUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === ALLOWED_HOST;
  } catch (e) {
    return false;
  }
}

function pickTab(tabs) {
  return tabs.find((t) => t.active) || tabs[0];
}

async function init() {
  const { lastScan } = await chrome.storage.local.get('lastScan');
  const tabs = await chrome.tabs.query({ url: RAMP_URL_PATTERN });

  document.getElementById('rescan-btn').disabled = tabs.length === 0;
  document.getElementById('open-page-btn').textContent = tabs.length
    ? 'Focus expenses tab'
    : 'Open my expenses';

  if (!lastScan) {
    document.getElementById('meta').textContent =
      'No scan yet — open the expenses page; the floating button in its ' +
      'bottom-right corner scans automatically the first time you open it.';
    renderList();
    return;
  }

  flagged = lastScan.flagged;
  selected = new Set(flagged.map((r) => r.href));
  const when = new Date(lastScan.scannedAt).toLocaleString();
  document.getElementById('meta').textContent =
    `${lastScan.rangeLabel} · ${lastScan.scannedCount} scanned · ${flagged.length} flagged · ${when}` +
    (tabs.length ? '' : ' (no expenses tab open — may be stale)');
  renderList();
}

function renderList() {
  const list = document.getElementById('list');
  list.innerHTML = '';

  if (!flagged.length) {
    list.innerHTML = '<div class="empty">Nothing flagged.</div>';
    document.getElementById('open-selected-btn').style.display = 'none';
    return;
  }

  flagged.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(row.href);
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(row.href);
      else selected.delete(row.href);
      updateOpenBtn();
    });

    const tags = [];
    if (row.missingMemo) tags.push('no memo');
    if (row.missingReceipt) tags.push('no receipt');

    const text = document.createElement('span');
    text.innerHTML =
      `<span class="merchant">${escapeHtml(row.merchant)}</span>` +
      `<span class="meta">${escapeHtml(row.dateLabel)} · ${escapeHtml(row.amount)} · ` +
      `<span class="tags">${tags.join(', ')}</span></span>`;

    const link = document.createElement('a');
    link.href = row.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'open-one';
    link.textContent = 'open';
    link.setAttribute('aria-label', `Open ${row.merchant} expense`);

    item.addEventListener('click', (e) => {
      if (e.target === cb || e.target === link) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });

    item.appendChild(cb);
    item.appendChild(text);
    item.appendChild(link);
    list.appendChild(item);
  });

  document.getElementById('open-selected-btn').style.display = 'block';
  updateOpenBtn();
}

function updateOpenBtn() {
  const btn = document.getElementById('open-selected-btn');
  btn.textContent = `Open ${selected.size} selected in new tabs`;
  btn.disabled = selected.size === 0;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

document.getElementById('open-selected-btn').addEventListener('click', () => {
  flagged
    .filter((r) => selected.has(r.href))
    .map((r) => r.href)
    .filter(isSafeRampUrl)
    .forEach((url) => chrome.tabs.create({ url }));
});

document.getElementById('rescan-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: RAMP_URL_PATTERN });
  if (!tabs.length) return;
  const tab = pickTab(tabs);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' });
  } catch (e) {
    document.getElementById('meta').textContent =
      "Couldn't reach the expenses tab — try reloading it, then rescan again.";
    return;
  }
  chrome.tabs.update(tab.id, { active: true });
  window.close();
});

document.getElementById('open-page-btn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: RAMP_URL_PATTERN });
  if (tabs.length) {
    chrome.tabs.update(pickTab(tabs).id, { active: true });
  } else {
    chrome.tabs.create({ url: RAMP_DEFAULT_URL });
  }
  window.close();
});

init();
