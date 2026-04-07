/**
 * Agent helper library injected into every page via
 * Page.addScriptToEvaluateOnNewDocument. Exposes `window.__agent` with small,
 * composable primitives the agent can call from `browser.evaluate` instead of
 * re-authoring DOM glue every time.
 */

export const AGENT_HELPERS_SCRIPT = `
(() => {
  if (window.__agent) return;

  const visible = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const byText = (text, opts = {}) => {
    const tag = (opts.tag || '*').toLowerCase();
    const exact = !!opts.exact;
    const needle = String(text);
    const nodes = document.querySelectorAll(tag);
    for (const el of nodes) {
      const t = (el.textContent || '').trim();
      if (exact ? t === needle : t.includes(needle)) return el;
    }
    return null;
  };

  const text = (sel) => {
    const el = sel ? $(sel) : document.body;
    return el ? (el.innerText || el.textContent || '').trim() : null;
  };

  const fill = (sel, value) => {
    const el = $(sel);
    if (!el) throw new Error('fill: element not found: ' + sel);
    el.focus();
    if ('value' in el) {
      const proto = Object.getPrototypeOf(el);
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    } else {
      el.textContent = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };

  const click = (sel) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (!el) throw new Error('click: element not found: ' + sel);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    return true;
  };

  const waitFor = (cond, opts = {}) => {
    const timeout = opts.timeout ?? 5000;
    const interval = opts.interval ?? 100;
    const start = Date.now();
    const check = typeof cond === 'string' ? () => $(cond) : cond;
    return new Promise((resolve, reject) => {
      const tick = () => {
        let val;
        try { val = check(); } catch (e) { return reject(e); }
        if (val) return resolve(val);
        if (Date.now() - start > timeout) return reject(new Error('waitFor: timeout after ' + timeout + 'ms'));
        setTimeout(tick, interval);
      };
      tick();
    });
  };

  const table = (sel) => {
    const el = $(sel);
    if (!el) return null;
    const headers = $$('th', el).map((h) => (h.innerText || '').trim());
    const rows = $$('tr', el)
      .map((tr) => $$('td', tr).map((td) => (td.innerText || '').trim()))
      .filter((r) => r.length > 0);
    return { headers, rows };
  };

  const attrs = (sel) => {
    const el = $(sel);
    if (!el) return null;
    const out = {};
    for (const a of el.attributes) out[a.name] = a.value;
    if ('value' in el) out.value = el.value;
    if ('checked' in el) out.checked = el.checked;
    return out;
  };

  const forms = () => {
    return $$('form').filter(visible).map((f) => ({
      action: f.action,
      method: f.method,
      fields: $$('input,select,textarea', f).map((i) => ({
        name: i.name,
        type: i.type,
        value: i.value,
      })),
    }));
  };

  const summary = () => ({
    url: location.href,
    title: document.title,
    headings: $$('h1,h2,h3').slice(0, 30).map((h) => ({
      level: h.tagName.toLowerCase(),
      text: (h.innerText || '').trim().slice(0, 200),
    })),
    links: $$('a[href]').slice(0, 50).map((a) => ({
      text: (a.innerText || '').trim().slice(0, 120),
      href: a.href,
    })),
    forms: $$('form').length,
  });

  window.__agent = { $, $$, byText, text, fill, click, waitFor, table, attrs, forms, summary };
})();
`;
