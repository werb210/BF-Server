import { describe, expect, it } from "vitest";
import fs from "node:fs";

const START_ROUTE_FILE = "src/routes/publicApplication.ts";

describe("Block 20 — /api/public/application/start timeout guard", () => {
  it("adds v20 timeout phase guard and timeout payload markers", () => {
    const route = fs.readFileSync(START_ROUTE_FILE, "utf8");
    expect(route).toContain("BF_START_PHASE_GUARD_v20");
    expect(route).toContain("start_handler_timeout");
    expect(route).toContain("last_phase");
  });
});
