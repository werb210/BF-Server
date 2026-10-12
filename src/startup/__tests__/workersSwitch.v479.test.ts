// BF_SERVER_BLOCK_v479_BF_WORKERS_SWITCH
import { afterEach, describe, it, expect } from "vitest";
import { bootIndex, type Boot } from "../../__tests__/helpers/bootIndex.js";
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
  describe("gates the whole worker block in index.ts, before the first worker starts", () => {
    let boot: Boot | null = null;
    afterEach(() => { boot?.restore(); boot = null; });

    it("BF_WORKERS_ENABLED=false starts no worker at all and says so", async () => {
      boot = await bootIndex({ env: { BF_WORKERS_ENABLED: "false" } });
      expect(boot.started()).toEqual([]);
      expect(boot.events).toContain("listen"); // the API itself still serves
      expect(boot.logText("warn")).toContain("BF workers NOT started: BF_WORKERS_ENABLED=false");
      expect(boot.handlers.has("SIGTERM")).toBe(false);
    });

    it("unset starts every worker, OCR first and through the FX rate worker", async () => {
      boot = await bootIndex({ env: { BF_WORKERS_ENABLED: undefined } });
      await boot.workersDone();
      const started = boot.started();
      expect(started[0]).toBe("startOcrWorker");
      expect(started).toContain("startFxRateWorker");
      expect(boot.logText("warn")).not.toContain("BF workers NOT started");
    });

    it("NODE_ENV=test starts no worker either", async () => {
      boot = await bootIndex({ nodeEnv: "test" });
      expect(boot.started()).toEqual([]);
    });
  });
});
