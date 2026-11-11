import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

// Vitest runs the workspace's tests (client/, desktop/, relay/, tools/). site/ runs its own, as its README says.
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
