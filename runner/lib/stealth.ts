import type { CdpClient } from "./cdp.ts";
import { AGENT_HELPERS_SCRIPT } from "./agent-helpers.ts";

const STEALTH_SCRIPT = `
const navProto = Object.getPrototypeOf(navigator);
Object.defineProperty(navProto, 'webdriver', {
  get: () => false,
  configurable: true,
});

for (const prop in window) {
  if (/^(cdc_|\\$cdc_|\\$wdc_|__webdriver)/.test(prop)) delete window[prop];
}

if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    connect: function() { return { onMessage: { addListener: function() {} }, postMessage: function() {}, onDisconnect: { addListener: function() {} } }; },
    sendMessage: function() {},
  };
}

const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
window.navigator.permissions.query = (params) =>
  params.name === 'notifications'
    ? Promise.resolve({ state: Notification.permission, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true })
    : origQuery(params);

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

if (!navigator.languages || navigator.languages.length === 0) {
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
}
`;

export async function enableDomainsStealthy(cdp: CdpClient): Promise<void> {
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: AGENT_HELPERS_SCRIPT });
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.disable");
}
