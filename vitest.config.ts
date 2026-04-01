import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/tests/env.setup.ts", "./src/tests/setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["src/lib/db.test.ts", "node_modules/**"],
  },
});
