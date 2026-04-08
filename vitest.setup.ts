import { applyTestEnvDefaults } from "./src/test/setupEnv";
import { beforeEach, vi } from "vitest";

import { deps } from "@/system/deps";
import { resetMetrics } from "@/system/metrics";

applyTestEnvDefaults();

beforeEach(() => {
  vi.clearAllMocks();

  deps.db.ready = true;
  deps.db.client = {
    query: async () => ({ rows: [], rowCount: 1 }),
  };

  resetMetrics();
});
