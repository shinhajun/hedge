// Service worker: one click on the toolbar button (or Alt+Shift+H) opens the side panel and starts
// listening to that tab. It owns the offscreen document that captures audio (a tab or the microphone)
// and streams it to Deepgram; the panel attaches to whatever is being captured.
const OFFSCREEN = 'offscreen.html';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener(onClick);
globalThis.actionClick = onClick; // lets the headless e2e take the same path as a click
function onClick(tab) {
  // Both calls happen inside the click: that is what lets Chrome open the panel and capture the tab.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
    const err = chrome.runtime.lastError?.message;
    if (err) {
      // Already listening to this tab: the click just opens the panel.
      if (/active stream/i.test(err)) return;
      return announce({ type: 'captureError', error: /Chrome pages/.test(err) ? 'chrome-page' : err });
    }
    startCapture({ source: 'tab', tabId: tab.id, streamId });
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { apiKey, deepgramKey } = await chrome.storage.local.get(['apiKey', 'deepgramKey']);
  if (!apiKey || !deepgramKey) chrome.runtime.openOptionsPage();
});

// Tell the panel; if it is still opening, it reads the same thing from session storage.
function announce(msg) {
  chrome.storage.session.set({ announce: { ...msg, at: Date.now() } });
  chrome.runtime.sendMessage(msg).catch(() => {});
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab or microphone audio and stream it to speech-to-text.',
  });
}

// The offscreen document may still be loading right after it is created.
async function toOffscreen(msg) {
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
    } catch (err) {
      if (i >= 20 || !/Receiving end does not exist/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function startCapture({ source, tabId, streamId }) {
  const { deepgramKey, micDevice } = await chrome.storage.local.get(['deepgramKey', 'micDevice']);
  if (!deepgramKey) {
    announce({ type: 'captureError', error: 'no-deepgram-key' });
    return { error: 'no-deepgram-key' };
  }
  await ensureOffscreen();
  const res = await toOffscreen({ type: 'start', source, tabId, streamId, deepgramKey, deviceId: source === 'mic' ? micDevice : undefined });
  if (res?.error) announce({ type: 'captureError', error: res.error });
  else announce({ type: 'captureStarted', source, tabId, startedAt: res.startedAt });
  return res;
}

// The panel's Listen button: the microphone, or a tab the user already clicked the toolbar button on.
async function listen({ source, tabId }) {
  if (source === 'mic') return startCapture({ source });
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    return startCapture({ source, tabId, streamId });
  } catch (err) {
    if (/active stream/i.test(err.message)) return { error: 'already' };
    return { error: /invoked|activeTab/.test(err.message) ? 'not-invoked' : /Chrome pages/.test(err.message) ? 'chrome-page' : err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'listen') {
    listen(msg).then(sendResponse, (err) => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'captureState') {
    (async () => ((await chrome.offscreen.hasDocument()) ? toOffscreen({ type: 'state' }) : { active: false }))().then(sendResponse, () => sendResponse({ active: false }));
    return true;
  }
  if (msg.type === 'stopListening') {
    (async () => {
      if (await chrome.offscreen.hasDocument()) {
        await toOffscreen({ type: 'stop' }).catch(() => {});
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    })().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
