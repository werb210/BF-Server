import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["src/test/setup.ts", "./src/tests/setup.ts"],
    testTimeout: 60000,
    hookTimeout: 60000
  }
})
