import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    isolate: true,
    setupFiles: ["src/tests/setupEnv.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/__tests__/db.real.integration.test.ts",
    ],
    sequence: {
      shuffle: false,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        types: ["vitest/globals"],
      },
    },
  },
});
