// BF_SERVER_BLOCK_v479_BF_WORKERS_SWITCH
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bfWorkersEnabled } from "../workersSwitch.js";

describe("v479 BF workers switch", () => {
  it("is on by default so production never stops by accident", () => {
    expect(bfWorkersEnabled({})).toBe(true);
    expect(bfWorkersEnabled({ BF_WORKERS_ENABLED: "true" })).toBe(true);
    expect(bfWorkersEnabled({ BF_WORKERS_ENABLED: "" })).toBe(true);
  });
  it("is off only when set to false", () => {
    expect(bfWorkersEnabled({ BF_WORKERS_ENABLED: "false" })).toBe(false);
    expect(bfWorkersEnabled({ BF_WORKERS_ENABLED: " FALSE " })).toBe(false);
  });
  it("gates the whole worker block in index.ts, before the first worker starts", () => {
    const src = readFileSync(fileURLToPath(new URL("../../index.ts", import.meta.url)), "utf-8");
    const gate = src.indexOf('if (process.env.NODE_ENV !== "test" && bfWorkersEnabled()) {');
    const first = src.indexOf("startOcrWorker()");
    const last = src.indexOf("startFxRateWorker(pool)");
    expect(gate).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(gate);
    expect(last).toBeGreaterThan(gate);
  });
});
