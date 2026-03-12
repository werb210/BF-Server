import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/test/**/*.test.ts",
      "tests/**/*.test.ts"
    ],
    globals: true,
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
