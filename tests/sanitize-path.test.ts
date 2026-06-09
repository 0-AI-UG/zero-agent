import { describe, expect, it } from "vitest";
import { sanitizePath, sanitizeValue } from "../web/src/lib/sanitize-path.ts";

describe("sanitizePath", () => {
  it("re-roots the production /app/data path at /", () => {
    // Regression: PI_PROJECTS_ROOT=/app/data/projects (see server/.ocd-deploy.json)
    // used to leave the `/app` segment dangling -> `/app./.pi`.
    expect(sanitizePath("/app/data/projects/3fjAOHPDTXR8rg4aYn3dU/.pi")).toBe("/.pi");
    expect(sanitizePath("/app/data/projects/abc/foo/bar.ts")).toBe("/foo/bar.ts");
  });

  it("re-roots the /var/zero code-default path at /", () => {
    expect(sanitizePath("/var/zero/projects/abc/.pi")).toBe("/.pi");
  });

  it("re-roots the local-dev /Users path at /", () => {
    expect(sanitizePath("/Users/anton/Dev/zero-agent/data/projects/abc/x.ts")).toBe("/x.ts");
  });

  it("re-roots a project path embedded in surrounding text", () => {
    expect(sanitizePath('read "/app/data/projects/abc/.pi/SYSTEM.md" ok')).toBe(
      'read "/.pi/SYSTEM.md" ok',
    );
  });

  it("collapses the project root itself to /", () => {
    expect(sanitizePath("/app/data/projects/abc")).toBe("/");
  });

  it("collapses the container deploy root /app to ~ (non-project internals)", () => {
    expect(sanitizePath("zero-sdk -> /app/zero/src/sdk")).toBe("zero-sdk -> ~/zero/src/sdk");
    expect(sanitizePath("/app/node_modules/x")).toBe("~/node_modules/x");
    expect(sanitizePath("/app")).toBe("~");
  });

  it("does NOT collapse an app/ directory that lives inside a project", () => {
    // The project's own `app/` dir re-roots to `/app/...` and must be left
    // alone — only the container root `/app` at a path boundary collapses.
    expect(sanitizePath("/app/data/projects/abc/app/main.ts")).toBe("/app/main.ts");
    expect(sanitizePath("/app/data/projects/abc/sub/app/x")).toBe("/sub/app/x");
  });

  it("handles project and container-root paths in the same string", () => {
    expect(sanitizePath("see /app/data/projects/abc/.pi and /app/zero/y")).toBe(
      "see /.pi and ~/zero/y",
    );
  });

  it("leaves unrelated absolute paths untouched (no project segment)", () => {
    expect(sanitizePath("no project path here /etc/hosts")).toBe("no project path here /etc/hosts");
  });

  it("collapses leftover /Users home paths to ~", () => {
    expect(sanitizePath("/Users/anton/.config/thing")).toBe("~/.config/thing");
  });

  it("is a no-op on empty input", () => {
    expect(sanitizePath("")).toBe("");
  });
});

describe("sanitizeValue", () => {
  it("recurses through objects and arrays", () => {
    const input = {
      path: "/app/data/projects/abc/.pi",
      nested: { files: ["/var/zero/projects/abc/a.ts", "plain"] },
      count: 3,
    };
    expect(sanitizeValue(input)).toEqual({
      path: "/.pi",
      nested: { files: ["/a.ts", "plain"] },
      count: 3,
    });
  });
});
