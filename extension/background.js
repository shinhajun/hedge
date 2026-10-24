// Service worker: opens the side panel from the toolbar button and owns the offscreen document that
// captures audio (a tab or the microphone) and streams it to Deepgram.
const OFFSCREEN = 'offscreen.html';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { apiKey, deepgramKey } = await chrome.storage.local.get(['apiKey', 'deepgramKey']);
  if (!apiKey || !deepgramKey) chrome.runtime.openOptionsPage();
});

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

async function listen({ source, tabId }) {
  const { deepgramKey } = await chrome.storage.local.get('deepgramKey');
  if (!deepgramKey) return { error: 'no-deepgram-key' };
  if (await chrome.offscreen.hasDocument()) await toOffscreen({ type: 'stop' });
  let streamId;
  if (source === 'tab') {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      // Chrome lets an extension capture a tab only after the user invoked it there (toolbar button or shortcut).
      return { error: /invoked|activeTab/.test(err.message) ? 'not-invoked' : /Chrome pages/.test(err.message) ? 'chrome-page' : err.message };
    }
  }
  await ensureOffscreen();
  return toOffscreen({ type: 'start', source, streamId, deepgramKey });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'listen') {
    listen(msg).then(sendResponse, (err) => sendResponse({ error: err.message }));
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
