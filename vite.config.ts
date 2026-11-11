import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Vitest runs the TypeScript tests. The node:test files (*.test.mjs) run under `node --test` until their package is
// ported, so they stay out of this list.
export default defineConfig({
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/out/**", "**/.wrangler/**"],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
  },
});
