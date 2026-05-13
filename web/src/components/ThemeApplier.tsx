import { useEffect } from "react";
import { useColorModeStore, resolveColorMode } from "@/stores/color-mode";
import { themeConfigToCss } from "@/lib/theme-engine";

/**
 * Applies:
 * 1. Color mode (.dark class on <html>) from user preference store
 * 2. Custom user theme CSS (<style id="custom-theme">) — from JSON config or legacy raw CSS
 */
export function ThemeApplier() {
  const colorMode = useColorModeStore((s) => s.colorMode);
  const customTheme = useColorModeStore((s) => s.customTheme);
  const customThemeCss = useColorModeStore((s) => s.customThemeCss);

  // Color mode — toggle .dark class
  useEffect(() => {
    const root = document.documentElement;
    const apply = (isDark: boolean) => {
      root.classList.toggle("dark", isDark);
    };
    apply(resolveColorMode(colorMode) === "dark");

    if (colorMode === "system") {
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
  }, [colorMode]);

  // Custom theme CSS injection (JSON theme takes priority, legacy CSS as fallback)
  useEffect(() => {
    const id = "custom-theme";
    let el = document.getElementById(id) as HTMLStyleElement | null;
    const css = customTheme ? themeConfigToCss(customTheme) : customThemeCss;

    if (css) {
      if (!el) {
        el = document.createElement("style");
        el.id = id;
      }
      el.textContent = css;
      // Always (re-)append to move the element to the end of <head>. The
      // pre-paint inline script in index.html injects this style tag before
      // globals.css loads, so without re-appending it would lose the cascade
      // and the user's custom theme would be silently overridden.
      document.head.appendChild(el);
    } else if (el) {
      el.remove();
    }
  }, [customTheme, customThemeCss]);

  return null;
}
