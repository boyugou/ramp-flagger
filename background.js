// Persists the latest scan result so the popup can render it without
// re-scanning, and relays cross-context actions (opening flagged expenses
// in new tabs) that a content script cannot perform directly. Writing a
// memo happens entirely within content.js (Ramp's list view has its own
// inline-editable memo cell) — no background involvement needed for that.

const ALLOWED_HOST = 'app.ramp.com';

function isSafeRampUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === ALLOWED_HOST;
  } catch (e) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCAN_RESULT') {
    chrome.storage.local.set({ lastScan: msg.payload });
    const count = msg.payload.flagged.length;
    chrome.action.setBadgeText({ text: count ? String(count) : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#b8430d' });
  }

  if (msg.type === 'SCAN_ERROR') {
    // Mark the badge as stale rather than leaving the last (possibly
    // outdated) successful count looking current.
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#5a5a68' });
  }

  if (msg.type === 'OPEN_TABS') {
    const urls = Array.isArray(msg.payload?.urls) ? msg.payload.urls : [];
    urls.filter(isSafeRampUrl).forEach((url) => chrome.tabs.create({ url, active: false }));
  }
});
