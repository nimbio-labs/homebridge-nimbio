import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/version.ts"],
      // Just below what the suite achieves, so a regression fails the build.
      thresholds: { lines: 95, functions: 88, branches: 80, statements: 94 },
    },
  },
});
