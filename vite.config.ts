import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Vitest runs the workspace's tests (client/, relay/, tools/). desktop/ and site/ run their own, as their READMEs say.
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
