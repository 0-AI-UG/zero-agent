import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ColorMode = "dark" | "light" | "system";

interface ColorModeState {
  colorMode: ColorMode;
  setColorMode: (mode: ColorMode) => void;
  customThemeCss: string | null;
  customThemeName: string | null;
  setCustomTheme: (css: string | null, name: string | null) => void;
}

export const useColorModeStore = create<ColorModeState>()(
  persist(
    (set) => ({
      colorMode: "dark" as ColorMode,
      setColorMode: (colorMode) => set({ colorMode }),
      customThemeCss: null as string | null,
      customThemeName: null as string | null,
      setCustomTheme: (css, name) => set({ customThemeCss: css, customThemeName: name }),
    }),
    { name: "color-mode-preference" },
  ),
);

/** Resolve "system" to the actual mode based on OS preference. */
export function resolveColorMode(mode: ColorMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}
