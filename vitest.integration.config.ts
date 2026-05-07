import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./server"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/setup/global.ts"],
    setupFiles: ["tests/integration/setup/per-file.ts"],
    pool: "forks",
    forks: { singleFork: true },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 90_000,
    teardownTimeout: 60_000,
  },
});
