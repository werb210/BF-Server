import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./src/tests/setupEnv.ts", "./src/tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  esbuild: {
    tsconfigRaw: require("./tsconfig.test.json"),
  },
});
