import { create } from "zustand";
import { persist } from "zustand/middleware";
import { themeConfigToCss, type ThemeConfig } from "@/lib/theme-engine";

export type ColorMode = "dark" | "light" | "system";

interface ColorModeState {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  /** User-defined JSON theme (replaces old raw CSS approach) */
  customTheme: ThemeConfig | null;
  setCustomTheme: (theme: ThemeConfig | null) => void;
  /** Legacy: raw CSS string (kept for backward compat during migration) */
  customThemeCss: string | null;
  customThemeName: string | null;
  setCustomThemeCss: (css: string | null, name: string | null) => void;
}

export const useColorModeStore = create<ColorModeState>()(
  persist(
    (set) => ({
      colorMode: "dark" as ColorMode,
      setColorMode: (colorMode) => set({ colorMode }),
      customTheme: null as ThemeConfig | null,
      setCustomTheme: (theme) =>
        set({
          customTheme: theme,
          customThemeCss: theme ? themeConfigToCss(theme) : null,
          customThemeName: theme ? theme.name : null,
        }),
      customThemeCss: null as string | null,
      customThemeName: null as string | null,
      setCustomThemeCss: (css, name) => set({ customThemeCss: css, customThemeName: name, customTheme: null }),
    }),
    {
      name: "color-mode-preference",
      onRehydrateStorage: () => (state) => {
        if (state?.customTheme && !state.customThemeCss) {
          state.setCustomTheme(state.customTheme);
        }
      },
    },
  ),
);

/** Resolve "system" to the actual mode based on OS preference. */
export function resolveColorMode(mode: ColorMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}
