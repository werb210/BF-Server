import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: [],
    isolate: true,
    include: ["src/__tests__/**/*.test.ts", "src/e2e/**/*.test.ts"],
    exclude: ["src/lib/db.test.ts", "node_modules/**"],
  },
});
