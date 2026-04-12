/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "@/lib/service-worker";

// PWA links injected via JS because Bun's HTML bundler resolves <link> hrefs
for (const [rel, href] of [
  ["manifest", "/manifest.webmanifest"],
  ["apple-touch-icon", "/icons/icon-192.png"],
] as const) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  document.head.appendChild(link);
}

registerServiceWorker();

const elem = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
