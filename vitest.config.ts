import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    clearMocks: true,
    restoreMocks: true,
    mockReset: true,
    setupFiles: ["src/test/setup.ts"],
    include: ["src/test/**/*.test.ts", "src/modules/**/__tests__/**/*.test.ts"],
    exclude: ["src/test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      exclude: ["node_modules", "dist"],
    },
  },
});
