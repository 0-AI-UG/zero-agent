import { serve } from "bun";
import path from "path";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const IS_PROD = process.env.NODE_ENV === "production";

if (!API_URL || !API_URL.startsWith("http")) {
  console.error(`Invalid API_URL: "${API_URL}" — set a valid API_URL env variable`);
  process.exit(1);
}

// In production, serve pre-built static files from the dist directory.
// In dev, use Bun's HTML import for HMR support.
const STATIC_DIR = IS_PROD ? path.join(import.meta.dir, "../dist") : null;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

async function serveStatic(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const headers: Record<string, string> = { "Content-Type": contentType };
  // Cache hashed assets for 1 year
  if (/[-\.][a-z0-9]{8,}\.\w+$/.test(filePath)) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  }
  return new Response(file, { headers });
}

// In dev, use Bun's HTML import for HMR. In prod, this is never loaded.
let devIndex: any = null;
if (!IS_PROD) {
  // Dynamic path prevents Bun from resolving this at parse time in production
  const htmlPath = "./index.html";
  devIndex = (await import(htmlPath)).default;
}

const server = serve({
  port: Number(process.env.PORT ?? 3000),

  routes: {
    "/health": {
      GET: () => new Response("OK", { status: 200 }),
    },

    // Proxy /api/* to the backend API server
    "/api/*": (req, server) => {
      server.timeout(req, 0);
      const url = new URL(req.url);
      const target = `${API_URL}${url.pathname}${url.search}`;

      const headers: Record<string, string> = {
        "Content-Type": req.headers.get("Content-Type") ?? "application/json",
      };
      const auth = req.headers.get("Authorization");
      if (auth) headers["Authorization"] = auth;

      return fetch(target, {
        method: req.method,
        headers,
        body: req.body,
      });
    },

    ...(!IS_PROD ? { "/*": devIndex } : {}),
  },

  // In production, serve static files and SPA fallback
  ...(IS_PROD
    ? {
        async fetch(req) {
          const url = new URL(req.url);
          // Try serving a static file from dist
          const filePath = path.join(STATIC_DIR!, url.pathname === "/" ? "index.html" : url.pathname);
          const staticRes = await serveStatic(filePath);
          if (staticRes) return staticRes;
          // SPA fallback — serve index.html for all other routes
          return (await serveStatic(path.join(STATIC_DIR!, "index.html")))!;
        },
      }
    : {}),

  development: !IS_PROD && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
