import type { CdpClient } from "./cdp.ts";

/**
 * Stealth script injected via Page.addScriptToEvaluateOnNewDocument.
 * Runs before any page JS to patch common bot-detection vectors.
 */
const STEALTH_SCRIPT = `
// 1. navigator.webdriver — patch on the prototype so 'webdriver' in navigator returns true
//    but the value is false (matches non-automated Chrome behavior)
const navProto = Object.getPrototypeOf(navigator);
Object.defineProperty(navProto, 'webdriver', {
  get: () => false,
  configurable: true,
});

// 2. CDP window property cleanup
for (const prop in window) {
  if (/^(cdc_|\\$cdc_|\\$wdc_|__webdriver)/.test(prop)) delete window[prop];
}

// 3. Ensure window.chrome and window.chrome.runtime exist (with sendMessage stub)
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, onDisconnect: { addListener: function() {} } }; },
    sendMessage: function() {},
  };
}

// 4. Permissions query patch — notifications should return actual permission state
const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
window.navigator.permissions.query = (params) =>
  params.name === 'notifications'
    ? Promise.resolve({ state: Notification.permission, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
    : origQuery(params);

// 5. Patch navigator.plugins to report default Chrome plugins
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    plugins.length = 3;
    return plugins;
  },
});

// 6. Patch navigator.languages if empty
if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
}
`;

/**
 * Enable CDP domains with stealth measures.
 * Uses the quick enable/disable cycle for Runtime domain to avoid detection.
 */
export async function enableDomainsStealthy(cdp: CdpClient): Promise<void> {
  // Safe domains — these don't trigger bot detection
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");

  // Inject stealth patches before any page JS runs
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT });

  // Runtime enable/disable cycle — capture execution contexts briefly, then disable
  // to avoid the persistent Runtime.enable detection signal
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.disable");
}
