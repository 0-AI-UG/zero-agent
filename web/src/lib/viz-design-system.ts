/**
 * Viz Design System — injected into .viz iframe srcDoc.
 *
 * The agent writes structural HTML + layout CSS with semantic `data-viz`
 * attributes. This module provides the visual layer: colors, typography,
 * entry animations, hover states.
 */

// ---------------------------------------------------------------------------
// Color tokens (resolved from globals.css so the iframe has concrete values)
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

// ---------------------------------------------------------------------------
// Stylesheet builder
// ---------------------------------------------------------------------------

export function buildVizStylesheet(isDark: boolean): string {
  const t = isDark ? DARK : LIGHT;

  return `
/* ── Viz Design System ── */

:root {
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
}

/* ── Base ── */

body {
  font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
  color: var(--viz-fg);
  background: var(--viz-bg);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1, h2, h3, h4, h5, h6 {
  font-family: 'Bricolage Grotesque', 'DM Sans', system-ui, sans-serif;
  color: var(--viz-fg);
  line-height: 1.2;
}

/* ── Semantic elements ── */

[data-viz="card"], [data-viz="node"] {
  background: var(--viz-card);
  color: var(--viz-card-fg);
  border: 1px solid var(--viz-border);
  border-radius: var(--viz-radius);
}

[data-viz="edge"], .viz-edge {
  stroke: var(--viz-muted-fg);
  stroke-width: 1.5;
}

[data-viz="badge"] {
  background: var(--viz-muted);
  color: var(--viz-muted-fg);
  border-radius: 9999px;
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  display: inline-block;
}

[data-viz="muted"] {
  color: var(--viz-muted-fg);
}

[data-viz="highlight"] {
  background: var(--viz-primary);
  color: var(--viz-primary-fg);
}

[data-viz="destructive"] {
  color: var(--viz-destructive);
  border-color: var(--viz-destructive);
}

/* ── Chart color utilities ── */

.viz-chart-1 { color: var(--viz-chart-1); fill: var(--viz-chart-1); stroke: var(--viz-chart-1); }
.viz-chart-2 { color: var(--viz-chart-2); fill: var(--viz-chart-2); stroke: var(--viz-chart-2); }
.viz-chart-3 { color: var(--viz-chart-3); fill: var(--viz-chart-3); stroke: var(--viz-chart-3); }
.viz-chart-4 { color: var(--viz-chart-4); fill: var(--viz-chart-4); stroke: var(--viz-chart-4); }
.viz-chart-5 { color: var(--viz-chart-5); fill: var(--viz-chart-5); stroke: var(--viz-chart-5); }

/* ── Links ── */

a, [data-viz="link"] {
  color: var(--viz-primary);
  transition: opacity 0.15s;
}
a:hover, [data-viz="link"]:hover {
  opacity: 0.8;
}

/* ── Entry animations ── */

@keyframes viz-fade-in {
  from { opacity: 0; transform: translateY(4px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes viz-scale-in {
  from { opacity: 0; transform: scale(0.92); }
  to   { opacity: 1; transform: scale(1); }
}

[data-viz="card"], [data-viz="node"] {
  animation: viz-fade-in 0.3s cubic-bezier(0.4, 0, 0.2, 1) both;
}

[data-viz="badge"] {
  animation: viz-scale-in 0.25s cubic-bezier(0.4, 0, 0.2, 1) both;
}

/* Stagger support */
[data-viz-delay="1"] { animation-delay: 50ms; }
[data-viz-delay="2"] { animation-delay: 100ms; }
[data-viz-delay="3"] { animation-delay: 150ms; }
[data-viz-delay="4"] { animation-delay: 200ms; }
[data-viz-delay="5"] { animation-delay: 250ms; }
[data-viz-delay="6"] { animation-delay: 300ms; }
[data-viz-delay="7"] { animation-delay: 350ms; }
[data-viz-delay="8"] { animation-delay: 400ms; }

/* ── Hover states ── */

[data-viz="card"]:hover, [data-viz="node"]:hover {
  border-color: var(--viz-ring);
  box-shadow: 0 0 0 1px var(--viz-ring);
  transition: border-color 0.15s, box-shadow 0.15s;
}

/* ── Streaming mode: shorter animations, no hover effects ── */

.viz-streaming [data-viz="card"],
.viz-streaming [data-viz="node"] {
  animation-duration: 0.15s;
}

.viz-streaming [data-viz="badge"] {
  animation-duration: 0.1s;
}

.viz-streaming [data-viz="card"]:hover,
.viz-streaming [data-viz="node"]:hover {
  border-color: var(--viz-border);
  box-shadow: none;
}
`;
}

// ---------------------------------------------------------------------------
// Injection into HTML srcDoc
// ---------------------------------------------------------------------------

export function injectVizDesignSystem(
  html: string,
  options: { isDark: boolean; streaming: boolean },
): string {
  const css = buildVizStylesheet(options.isDark);
  const modeClass = options.streaming ? "viz-streaming" : "viz-complete";
  const styleTag = `<style id="viz-design-system">${css}</style>`;

  // Add mode class to <html> if present
  let result = html;
  const htmlTagMatch = result.match(/<html([^>]*)>/i);
  if (htmlTagMatch) {
    const existing = htmlTagMatch[1] ?? "";
    const classMatch = existing.match(/class="([^"]*)"/);
    if (classMatch) {
      result = result.replace(
        classMatch[0],
        `class="${classMatch[1]} ${modeClass}"`,
      );
    } else {
      result = result.replace(
        htmlTagMatch[0],
        `<html${existing} class="${modeClass}">`,
      );
    }
  } else {
    // No <html> tag — wrap content
    result = `<html class="${modeClass}">${result}</html>`;
  }

  // Inject stylesheet into <head> or at document start
  const headIdx = result.indexOf("<head>");
  if (headIdx !== -1) {
    const insertAt = headIdx + "<head>".length;
    result = result.slice(0, insertAt) + styleTag + result.slice(insertAt);
  } else {
    const htmlIdx = result.indexOf(">", result.indexOf("<html"));
    if (htmlIdx !== -1) {
      const insertAt = htmlIdx + 1;
      result =
        result.slice(0, insertAt) +
        `<head>${styleTag}</head>` +
        result.slice(insertAt);
    }
  }

  return result;
}
