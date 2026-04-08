import { useEffect } from "react";
import { useServerCapabilities } from "@/api/capabilities";

/**
 * Applies the active UI theme (driven by the admin-controlled UI_THEME
 * setting, served via /capabilities) to <html data-theme="...">.
 */
export function ThemeApplier() {
  const { data } = useServerCapabilities();
  const theme = data?.theme ?? "default";

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "default") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }, [theme]);

  return null;
}
