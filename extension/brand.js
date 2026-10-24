// The product name lives in _locales/en/messages.json (appName) so the manifest can use it too.
export const PRODUCT_NAME = chrome.i18n.getMessage('appName');

// Fills [data-brand] elements and the page title's {name} placeholder.
export function applyBrand(doc = document) {
  doc.title = doc.title.replaceAll('{name}', PRODUCT_NAME);
  for (const el of doc.querySelectorAll('[data-brand]')) el.textContent = PRODUCT_NAME;
}
