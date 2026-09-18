// BF_SERVER_FX_RATE_WORKER_v355 / BF_SERVER_ACTIVE_EXCLUDES_CLOSED_v355
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import { parseValetUsdCad, refreshUsdCadRate } from "../workers/fxRateWorker.js";

describe("Bank of Canada USD/CAD rate", () => {
  it("parses the Valet response", () => {
    expect(parseValetUsdCad({ observations: [{ d: "2026-09-17", FXUSDCAD: { v: "1.3712" } }] }))
      .toEqual({ rate: 1.3712, date: "2026-09-17" });
  });
  it("rejects nonsense so a bad response never overwrites the last good rate", () => {
    expect(parseValetUsdCad({ observations: [] })).toBeNull();
    expect(parseValetUsdCad({ observations: [{ d: "2026-09-17", FXUSDCAD: { v: "137" } }] })).toBeNull();
    expect(parseValetUsdCad({ observations: [{ d: "yesterday", FXUSDCAD: { v: "1.37" } }] })).toBeNull();
  });
  it("stores the rate and the Bank of Canada date", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ observations: [{ d: "2026-09-17", FXUSDCAD: { v: "1.3712" } }] }) });
    const out = await refreshUsdCadRate({ query } as any, fetchImpl as any);
    expect(out).toEqual({ rate: 1.3712, date: "2026-09-17" });
    expect(query.mock.calls[0][1]).toEqual([1.3712, "2026-09-17"]);
  });
  it("leaves the stored rate alone when the fetch fails", async () => {
    const query = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await refreshUsdCadRate({ query } as any, vi.fn().mockResolvedValue({ ok: false, status: 503 }) as any);
    expect(out).toBeNull();
    expect(query).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("dashboard", () => {
  const dash = fs.readFileSync("src/routes/dashboard.ts", "utf8");
  const index = fs.readFileSync("src/index.ts", "utf8");
  it("active applications exclude closed deals", () => {
    expect(dash).toContain("NOT IN ('Rejected', 'Accepted') -- BF_SERVER_ACTIVE_EXCLUDES_CLOSED_v355");
  });
  it("reports the rate it used", () => {
    expect(dash).toContain("FROM fx_rates WHERE currency = 'USD' LIMIT 1");
    expect(dash).toMatch(/commissionEarnedByCurrency: [^\n]+\n\s+fx,/);
  });
  it("starts the rate worker", () => {
    expect(index).toContain("startFxRateWorker(pool)");
  });
});
