/**
 * Viz Design System — injected into the .viz iframe.
 *
 * The agent writes **fragments**: just the structural HTML + layout CSS + optional
 * `<script>`. This module provides the shell (doctype, html, head, body), the
 * visual layer (CSS reset, typography, colors, animations, utility classes),
 * and a tiny resize script that posts height back to the parent frame.
 *
 * Theme switches are done by toggling `document.documentElement.dataset.theme`
 * from the parent — both light and dark tokens are always shipped so we never
 * need to reload the iframe on theme change.
 */

// ---------------------------------------------------------------------------
// Color tokens — both themes ship in the stylesheet, scoped by [data-theme].
// ---------------------------------------------------------------------------

const LIGHT = {
  bg: "oklch(1 0 0)",
  fg: "oklch(0.145 0 0)",
  card: "oklch(1 0 0)",
  cardFg: "oklch(0.145 0 0)",
  primary: "oklch(0.55 0.18 250)",
  primaryFg: "oklch(0.99 0 0)",
  muted: "oklch(0.97 0 0)",
  mutedFg: "oklch(0.556 0 0)",
  accent: "oklch(0.97 0 0)",
  accentFg: "oklch(0.205 0 0)",
  destructive: "oklch(0.577 0.245 27.325)",
  border: "oklch(0.922 0 0)",
  input: "oklch(0.922 0 0)",
  ring: "oklch(0.55 0.18 250 / 40%)",
  chart1: "oklch(0.646 0.222 41.116)",
  chart2: "oklch(0.6 0.118 184.704)",
  chart3: "oklch(0.398 0.07 227.392)",
  chart4: "oklch(0.828 0.189 84.429)",
  chart5: "oklch(0.769 0.188 70.08)",
  radius: "0.625rem",
};

const DARK = {
  bg: "oklch(0.13 0 0)",
  fg: "oklch(0.985 0 0)",
  card: "oklch(0.18 0 0)",
  cardFg: "oklch(0.985 0 0)",
  primary: "oklch(0.65 0.18 250)",
  primaryFg: "oklch(0.15 0 0)",
  muted: "oklch(0.22 0 0)",
  mutedFg: "oklch(0.708 0 0)",
  accent: "oklch(0.22 0 0)",
  accentFg: "oklch(0.985 0 0)",
  destructive: "oklch(0.704 0.191 22.216)",
  border: "oklch(1 0 0 / 10%)",
  input: "oklch(1 0 0 / 15%)",
  ring: "oklch(0.65 0.18 250 / 40%)",
  chart1: "oklch(0.488 0.243 264.376)",
  chart2: "oklch(0.696 0.17 162.48)",
  chart3: "oklch(0.769 0.188 70.08)",
  chart4: "oklch(0.627 0.265 303.9)",
  chart5: "oklch(0.645 0.246 16.439)",
  radius: "0.625rem",
};

function tokensBlock(t: typeof LIGHT): string {
  return `
  --viz-bg: ${t.bg};
  --viz-fg: ${t.fg};
  --viz-card: ${t.card};
  --viz-card-fg: ${t.cardFg};
  --viz-primary: ${t.primary};
  --viz-primary-fg: ${t.primaryFg};
  --viz-muted: ${t.muted};
  --viz-muted-fg: ${t.mutedFg};
  --viz-accent: ${t.accent};
  --viz-accent-fg: ${t.accentFg};
  --viz-destructive: ${t.destructive};
  --viz-border: ${t.border};
  --viz-input: ${t.input};
  --viz-ring: ${t.ring};
  --viz-chart-1: ${t.chart1};
  --viz-chart-2: ${t.chart2};
  --viz-chart-3: ${t.chart3};
  --viz-chart-4: ${t.chart4};
  --viz-chart-5: ${t.chart5};
  --viz-radius: ${t.radius};
`;
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

export function buildVizStylesheet(): string {
  return `
/* ── Viz Design System ── */

:root, [data-theme="light"] {${tokensBlock(LIGHT)}}
[data-theme="dark"]         {${tokensBlock(DARK)}}

/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
svg, img, video, canvas { display: block; max-width: 100%; }

html {
  background: var(--viz-bg);
  color: var(--viz-fg);
  transition: background 0.2s ease, color 0.2s ease;
}

body {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  color: var(--viz-fg);
  background: var(--viz-bg);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  padding: 16px;
}

h1, h2, h3, h4, h5, h6 {
  font-family: 'Bricolage Grotesque', 'DM Sans', system-ui, sans-serif;
  color: var(--viz-fg);
  line-height: 1.2;
  margin: 0;
}

p { margin: 0; }

/* ── Semantic elements ── */

[data-viz="card"], [data-viz="node"] {
  background: var(--viz-card);
  color: var(--viz-card-fg);
  border: 1px solid var(--viz-border);
  border-radius: var(--viz-radius);
  padding: 12px 14px;
}

/* In SVG context, data-viz="node" is usually a <g> — don't apply box styling to it. */
svg [data-viz="node"] { background: none; border: none; padding: 0; }
svg [data-viz="node"] > rect,
svg [data-viz="card"] > rect {
  fill: var(--viz-card);
  stroke: var(--viz-border);
  stroke-width: 1;
}

[data-viz="edge"], .viz-edge {
  stroke: var(--viz-muted-fg);
  stroke-width: 1.5;
  fill: none;
}

[data-viz="badge"] {
  background: var(--viz-muted);
  color: var(--viz-muted-fg);
  border-radius: 9999px;
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  display: inline-block;
}

[data-viz="muted"]       { color: var(--viz-muted-fg); }
[data-viz="highlight"]   { background: var(--viz-primary); color: var(--viz-primary-fg); }
[data-viz="destructive"] { color: var(--viz-destructive); border-color: var(--viz-destructive); }

/* ── Chart color utilities ── */
.viz-chart-1 { color: var(--viz-chart-1); fill: var(--viz-chart-1); stroke: var(--viz-chart-1); }
.viz-chart-2 { color: var(--viz-chart-2); fill: var(--viz-chart-2); stroke: var(--viz-chart-2); }
.viz-chart-3 { color: var(--viz-chart-3); fill: var(--viz-chart-3); stroke: var(--viz-chart-3); }
.viz-chart-4 { color: var(--viz-chart-4); fill: var(--viz-chart-4); stroke: var(--viz-chart-4); }
.viz-chart-5 { color: var(--viz-chart-5); fill: var(--viz-chart-5); stroke: var(--viz-chart-5); }

/* ── Layout utility classes ── */
.viz-stack { display: flex; flex-direction: column; gap: 12px; }
.viz-row   { display: flex; flex-direction: row;    gap: 12px; align-items: center; }
.viz-grid  { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }

/* ── Links ── */
a, [data-viz="link"] {
  color: var(--viz-primary);
  text-decoration: none;
  transition: opacity 0.15s;
}
a:hover, [data-viz="link"]:hover { opacity: 0.8; }

/* ── Entry animations ── */
@keyframes viz-blur-in {
  from { opacity: 0; filter: blur(6px); transform: translateY(6px); }
  to   { opacity: 1; filter: blur(0);   transform: translateY(0);   }
}
@keyframes viz-fade-in {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes viz-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes viz-stroke-draw {
  from { stroke-dashoffset: var(--viz-len, 1000); }
  to   { stroke-dashoffset: 0; }
}

[data-viz="card"], [data-viz="node"] {
  animation: viz-blur-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
}
[data-viz="badge"] {
  animation: viz-scale-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) both;
}
[data-viz="edge"], .viz-edge {
  stroke-dasharray: var(--viz-len, 1000);
  animation: viz-stroke-draw 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
}

/* Stagger */
[data-viz-delay="1"]  { animation-delay: 40ms; }
[data-viz-delay="2"]  { animation-delay: 80ms; }
[data-viz-delay="3"]  { animation-delay: 120ms; }
[data-viz-delay="4"]  { animation-delay: 160ms; }
[data-viz-delay="5"]  { animation-delay: 200ms; }
[data-viz-delay="6"]  { animation-delay: 240ms; }
[data-viz-delay="7"]  { animation-delay: 280ms; }
[data-viz-delay="8"]  { animation-delay: 320ms; }
[data-viz-delay="9"]  { animation-delay: 360ms; }
[data-viz-delay="10"] { animation-delay: 400ms; }
[data-viz-delay="11"] { animation-delay: 440ms; }
[data-viz-delay="12"] { animation-delay: 480ms; }

/* ── Hover states ── */
[data-viz="card"]:hover, [data-viz="node"]:hover {
  border-color: var(--viz-ring);
  box-shadow: 0 0 0 1px var(--viz-ring);
  transition: border-color 0.2s, box-shadow 0.2s;
}
svg [data-viz="node"]:hover > rect {
  stroke: var(--viz-primary);
  stroke-width: 2;
  transition: stroke 0.2s, stroke-width 0.2s;
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
`;
}

// ---------------------------------------------------------------------------
// Shell + fragment preparation
// ---------------------------------------------------------------------------

/**
 * Resize script — posts document height back to the parent window.
 * Embedded inside the shell so it runs once on load.
 */
const RESIZE_SCRIPT = `
(function(){
  var last=0,tid=0;
  function post(){
    var h=Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    if(h!==last){last=h;parent.postMessage({type:'viz-resize',height:h},'*');}
  }
  var ro=new ResizeObserver(function(){clearTimeout(tid);tid=setTimeout(post,40);});
  if(document.body) ro.observe(document.body);
  setTimeout(post,0);
  setTimeout(post,200);
  setTimeout(post,600);
})();
`;

/**
 * SVG defs injected globally so every <svg> can reference `url(#viz-arrow)` /
 * `url(#viz-arrow-hl)` without redeclaring markers. Rendered as an offscreen
 * svg in the shell.
 */
const GLOBAL_SVG_DEFS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <marker id="viz-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0L10 5L0 10z" fill="var(--viz-muted-fg)"/>
    </marker>
    <marker id="viz-arrow-hl" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0 0L10 5L0 10z" fill="var(--viz-primary)"/>
    </marker>
  </defs>
</svg>
`;

/**
 * Returns the complete shell HTML that is written to the iframe on first mount.
 * The agent's fragment is then streamed into #viz-root via document.write.
 */
export function buildVizShell(initialTheme: "light" | "dark"): string {
  return `<!doctype html>
<html lang="en" data-theme="${initialTheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style id="viz-design-system">${buildVizStylesheet()}</style>
<script>${RESIZE_SCRIPT}</script>
</head>
<body>
${GLOBAL_SVG_DEFS}
`;
}

/**
 * Strip doctype / html / head / body wrapper tags from agent-authored content so
 * a fragment can be written into an existing document without nesting a second
 * document. Inline `<style>` blocks inside the original `<head>` are preserved
 * by simply leaving them where they land after the head tags are stripped.
 *
 * This is a streaming-safe transform: it only removes opening/closing tags it
 * recognizes and never panics on unbalanced input.
 */
export function prepareFragment(content: string): string {
  let s = content;
  // Drop doctype
  s = s.replace(/<!doctype[^>]*>/gi, "");
  // Drop <html ...> and </html>
  s = s.replace(/<\/?html\b[^>]*>/gi, "");
  // Drop <head> and </head> — leaves inline <style>/<title> content in place.
  s = s.replace(/<\/?head\b[^>]*>/gi, "");
  // Drop <meta>, <title> (they're useless inside fragments)
  s = s.replace(/<meta\b[^>]*>/gi, "");
  s = s.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, "");
  // Drop <body> and </body>
  s = s.replace(/<\/?body\b[^>]*>/gi, "");
  return s;
}

/**
 * Build a complete, self-contained HTML document that embeds a fragment inside
 * the viz shell. Used by non-streaming callers (file preview page, PNG/PDF
 * export). Streaming callers should use `buildVizShell` + incremental writes
 * instead.
 */
export function injectVizDesignSystem(
  html: string,
  options: { isDark: boolean },
): string {
  const theme: "light" | "dark" = options.isDark ? "dark" : "light";
  const fragment = prepareFragment(html);
  return `${buildVizShell(theme)}${fragment}</body></html>`;
}

/**
 * Trim an *unclosed* trailing `<script>` or `<style>` tag from partial streamed
 * content, so the browser never renders raw source code as visible text before
 * the closing tag arrives.
 */
export function trimUnsafeTail(html: string): string {
  const lowered = html.toLowerCase();
  const lastScript = lowered.lastIndexOf("<script");
  const lastStyle = lowered.lastIndexOf("<style");
  const lastOpen = Math.max(lastScript, lastStyle);
  if (lastOpen === -1) return html;
  const tag = lastScript > lastStyle ? "</script>" : "</style>";
  if (lowered.lastIndexOf(tag) > lastOpen) return html;
  return html.slice(0, lastOpen);
}
