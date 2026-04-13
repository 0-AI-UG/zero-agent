/**
 * Theme Engine — converts a minimal JSON theme (5 seed colors + radius)
 * into the full set of CSS custom properties used by the app.
 *
 * Color math uses OKLCH (perceptually uniform) to match the existing
 * variable definitions in globals.css.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface ThemeColors {
  /** Page / app background */
  background: string;
  /** Primary text color */
  foreground: string;
  /** Accent / brand color (used for primary, ring, charts) */
  accent: string;
  /** Muted surfaces (secondary panels, hover states) */
  muted: string;
  /** Border / separator color */
  border: string;
}

export interface ThemeConfig {
  name: string;
  colors: {
    light: ThemeColors;
    dark: ThemeColors;
  };
  radius?: string;
}

// ── OKLCH color type ───────────────────────────────────────────────────

interface Oklch {
  l: number; // 0–1
  c: number; // 0–~0.4
  h: number; // 0–360
}

// ── Hex → sRGB → Linear RGB → OKLab → OKLCH pipeline ─────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
}

function linearRgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l = Math.cbrt(l_);
  const m = Math.cbrt(m_);
  const s = Math.cbrt(s_);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToLinearRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = hexToRgb(hex);
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const [L, a, bVal] = linearRgbToOklab(lr, lg, lb);
  const c = Math.sqrt(a * a + bVal * bVal);
  let h = (Math.atan2(bVal, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

export function oklchToHex(color: Oklch): string {
  const a = color.c * Math.cos((color.h * Math.PI) / 180);
  const b = color.c * Math.sin((color.h * Math.PI) / 180);
  const [lr, lg, lb] = oklabToLinearRgb(color.l, a, b);
  const r = linearToSrgb(lr);
  const g = linearToSrgb(lg);
  const bv = linearToSrgb(lb);
  return `#${((1 << 24) | (r << 16) | (g << 8) | bv).toString(16).slice(1)}`;
}

// ── OKLCH helpers ──────────────────────────────────────────────────────

function fmt(color: Oklch): string {
  return `oklch(${n(color.l)} ${n(color.c)} ${n(color.h)})`;
}

function fmtAlpha(color: Oklch, alpha: number): string {
  return `oklch(${n(color.l)} ${n(color.c)} ${n(color.h)} / ${Math.round(alpha * 100)}%)`;
}

function n(v: number): string {
  return Number(v.toFixed(4)).toString();
}

function shift(color: Oklch, delta: { l?: number; c?: number; h?: number }): Oklch {
  return {
    l: clamp(color.l + (delta.l ?? 0), 0, 1),
    c: clamp(color.c + (delta.c ?? 0), 0, 0.4),
    h: ((color.h + (delta.h ?? 0)) % 360 + 360) % 360,
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Auto-pick a foreground color that contrasts with the given background */
function contrastFg(bg: Oklch): Oklch {
  return bg.l > 0.6 ? { l: 0.15, c: 0, h: 0 } : { l: 0.95, c: 0, h: 0 };
}

// ── CSS generation ─────────────────────────────────────────────────────

function generateVars(colors: ThemeColors): string {
  const bg = hexToOklch(colors.background);
  const fg = hexToOklch(colors.foreground);
  const accent = hexToOklch(colors.accent);
  const muted = hexToOklch(colors.muted);
  const border = hexToOklch(colors.border);

  const mutedFg = shift(fg, { l: fg.l > 0.5 ? -0.25 : 0.25 });

  const lines = [
    `--background: ${fmt(bg)};`,
    `--foreground: ${fmt(fg)};`,
    `--card: ${fmt(shift(bg, { l: bg.l > 0.5 ? 0 : 0.02 }))};`,
    `--card-foreground: ${fmt(fg)};`,
    `--popover: ${fmt(shift(bg, { l: bg.l > 0.5 ? 0 : 0.02 }))};`,
    `--popover-foreground: ${fmt(fg)};`,
    `--primary: ${fmt(accent)};`,
    `--primary-foreground: ${fmt(contrastFg(accent))};`,
    `--secondary: ${fmt(shift(muted, { l: bg.l > 0.5 ? 0.02 : 0.03 }))};`,
    `--secondary-foreground: ${fmt(fg)};`,
    `--muted: ${fmt(muted)};`,
    `--muted-foreground: ${fmt(mutedFg)};`,
    `--accent: ${fmt(shift(muted, { l: bg.l > 0.5 ? 0.01 : 0.02 }))};`,
    `--accent-foreground: ${fmt(fg)};`,
    `--destructive: ${bg.l > 0.5 ? "oklch(0.577 0.245 27.325)" : "oklch(0.704 0.191 22.216)"};`,
    `--border: ${fmt(border)};`,
    `--input: ${fmt(shift(border, { l: bg.l > 0.5 ? 0 : 0.02 }))};`,
    `--ring: ${fmtAlpha(accent, 0.4)};`,
    `--chart-1: ${fmt(accent)};`,
    `--chart-2: ${fmt(shift(accent, { h: 60 }))};`,
    `--chart-3: ${fmt(shift(accent, { h: 120 }))};`,
    `--chart-4: ${fmt(shift(accent, { h: 180 }))};`,
    `--chart-5: ${fmt(shift(accent, { h: 240 }))};`,
    `--sidebar: ${fmt(shift(bg, { l: bg.l > 0.5 ? -0.015 : -0.02 }))};`,
    `--sidebar-foreground: ${fmt(fg)};`,
    `--sidebar-primary: ${fmt(accent)};`,
    `--sidebar-primary-foreground: ${fmt(contrastFg(accent))};`,
    `--sidebar-accent: ${fmt(shift(muted, { l: bg.l > 0.5 ? 0.01 : 0.02 }))};`,
    `--sidebar-accent-foreground: ${fmt(fg)};`,
    `--sidebar-border: ${fmt(border)};`,
    `--sidebar-ring: ${fmtAlpha(accent, 0.4)};`,
  ];

  return lines.map((l) => `  ${l}`).join("\n");
}

/**
 * Convert a ThemeConfig JSON object into a full CSS string
 * that overrides all theme variables for both light and dark modes.
 */
export function themeConfigToCss(config: ThemeConfig): string {
  const radius = config.radius ?? "0.625rem";
  const lightVars = generateVars(config.colors.light);
  const darkVars = generateVars(config.colors.dark);

  return `:root {
  --radius: ${radius};
${lightVars}
}

.dark {
${darkVars}
}`;
}

// ── Validation ─────────────────────────────────────────────────────────

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function validateThemeConfig(obj: unknown): { ok: true; config: ThemeConfig } | { ok: false; error: string } {
  if (!obj || typeof obj !== "object") return { ok: false, error: "Invalid JSON" };
  const o = obj as Record<string, unknown>;

  if (typeof o.name !== "string" || o.name.length === 0) {
    return { ok: false, error: "Theme must have a \"name\" field" };
  }
  if (!o.colors || typeof o.colors !== "object") {
    return { ok: false, error: "Theme must have a \"colors\" object" };
  }

  const colors = o.colors as Record<string, unknown>;

  // Support flat colors (auto-used for both modes) or light/dark split
  const hasFlat = typeof colors.background === "string";
  const hasSplit = colors.light && colors.dark;

  if (!hasFlat && !hasSplit) {
    return { ok: false, error: "colors must contain either {background, foreground, accent, muted, border} or {light: {...}, dark: {...}}" };
  }

  const validateColorSet = (set: unknown, label: string): string | null => {
    if (!set || typeof set !== "object") return `${label} must be an object`;
    const s = set as Record<string, unknown>;
    for (const key of ["background", "foreground", "accent", "muted", "border"] as const) {
      if (typeof s[key] !== "string" || !HEX_RE.test(s[key] as string)) {
        return `${label}.${key} must be a valid hex color (e.g. #1a1a2e)`;
      }
    }
    return null;
  };

  if (hasFlat) {
    const err = validateColorSet(colors, "colors");
    if (err) return { ok: false, error: err };
    const flat = colors as unknown as ThemeColors;
    return {
      ok: true,
      config: {
        name: o.name as string,
        colors: { light: flat, dark: flat },
        radius: typeof o.radius === "string" ? o.radius : undefined,
      },
    };
  }

  const errLight = validateColorSet(colors.light, "colors.light");
  if (errLight) return { ok: false, error: errLight };
  const errDark = validateColorSet(colors.dark, "colors.dark");
  if (errDark) return { ok: false, error: errDark };

  return {
    ok: true,
    config: {
      name: o.name as string,
      colors: {
        light: colors.light as ThemeColors,
        dark: colors.dark as ThemeColors,
      },
      radius: typeof o.radius === "string" ? o.radius : undefined,
    },
  };
}

// ── Default / example themes ───────────────────────────────────────────

export const EXAMPLE_THEMES: ThemeConfig[] = [
  {
    name: "Ocean",
    colors: {
      light: { background: "#f8f9fa", foreground: "#1a1a2e", accent: "#0066ff", muted: "#e9ecef", border: "#dee2e6" },
      dark: { background: "#0d1117", foreground: "#e6edf3", accent: "#58a6ff", muted: "#161b22", border: "#30363d" },
    },
  },
  {
    name: "Rose",
    colors: {
      light: { background: "#fef7f7", foreground: "#2d1b1b", accent: "#e11d48", muted: "#f5e6e8", border: "#e8d0d4" },
      dark: { background: "#1a0d10", foreground: "#f0e0e4", accent: "#fb7185", muted: "#2a1520", border: "#3d2030" },
    },
  },
  {
    name: "Forest",
    colors: {
      light: { background: "#f5f7f5", foreground: "#1a261a", accent: "#16a34a", muted: "#e6ede6", border: "#c8d8c8" },
      dark: { background: "#0d140d", foreground: "#dceadc", accent: "#4ade80", muted: "#152015", border: "#253025" },
    },
  },
  {
    name: "Amber",
    colors: {
      light: { background: "#fefcf5", foreground: "#291e05", accent: "#d97706", muted: "#f5edd6", border: "#e8dbb8" },
      dark: { background: "#161005", foreground: "#f0e6cc", accent: "#fbbf24", muted: "#221a0a", border: "#352a12" },
    },
  },
  {
    name: "Violet",
    colors: {
      light: { background: "#faf7ff", foreground: "#1e1533", accent: "#7c3aed", muted: "#ede6f7", border: "#d8cce8" },
      dark: { background: "#100d1a", foreground: "#e4daf0", accent: "#a78bfa", muted: "#1a1528", border: "#2a2040" },
    },
  },
];
