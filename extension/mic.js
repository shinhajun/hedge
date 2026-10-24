// Chrome only shows the microphone prompt on a visible page, so the side panel sends people here once.
import { applyBrand } from './brand.js';

applyBrand();
const result = document.getElementById('result');

document.getElementById('allow').onclick = async () => {
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const t of media.getTracks()) t.stop();
    result.dataset.state = 'ok';
    result.textContent = 'Done. Back to the side panel; this tab closes itself.';
    chrome.runtime.sendMessage({ type: 'micGranted' }).catch(() => {});
    setTimeout(() => window.close(), 1200);
  } catch {
    result.dataset.state = 'error';
    result.textContent = 'Chrome blocked the microphone. Allow it from the icon in the address bar, then try again.';
  }
};
