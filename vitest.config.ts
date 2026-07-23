import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";
// BF_SERVER_SPLIT_INTEGRATION_TESTS_v1 - see vitest.integration.ts for why
// these are separated. Run them against live infra with:
//   npm run test:integration
import { INTEGRATION_TEST_FILES } from "./vitest.integration.js";

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
      // BF_SERVER_SPLIT_INTEGRATION_TESTS_v1
      ...(process.env.VITEST_INTEGRATION === "true" ? [] : INTEGRATION_TEST_FILES),
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
