// BF_SERVER_FX_RATE_WORKER_v355 / BF_SERVER_ACTIVE_EXCLUDES_CLOSED_v355
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";
import { bootIndex } from "./helpers/bootIndex.js";

const query = vi.fn();
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (...a: unknown[]) => query(...a);
  return { ...real, dbQuery: q, pool: { query: q, connect: vi.fn() } };
});
import { parseValetUsdCad, refreshUsdCadRate } from "../workers/fxRateWorker.js";
import dashboardRoutes from "../routes/dashboard.js";

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
  const app = express();
  app.use("/api/dashboard", dashboardRoutes);
  const admin = "Bearer " + jwt.sign({ sub: "55555555-5555-4555-8555-555555555555", role: "Admin", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);
  const metrics = async () => {
    query.mockReset();
    query.mockImplementation(answerBySql([
      [/FROM fx_rates WHERE currency = 'USD' LIMIT 1/, { rows: [{ to_cad: "1.3712", as_of: "2026-09-17" }] }],
      [/SELECT x\.stage, x\.currency/, { rows: [{ stage: "Accepted", currency: "USD", native: "100", cad: "137.12" }] }],
      [/SELECT COUNT\(\*\)::text AS count FROM applications/, { rows: [{ count: "4" }] }],
    ]));
    return request(app).get("/api/dashboard/metrics").set("Authorization", admin);
  };

  it("active applications exclude closed deals", async () => {
    const r = await metrics();
    expect(r.status).toBe(200);
    const active = callsMatching(query, /SELECT COUNT\(\*\)::text AS count FROM applications\s+WHERE UPPER\(silo\) = UPPER\(\$1\)/)[0];
    expect(String(active[0])).toContain("COALESCE(pipeline_state, '') NOT IN ('Rejected', 'Accepted')");
  });
  it("reports the rate it used", async () => {
    const r = await metrics();
    expect(callsMatching(query, "FROM fx_rates WHERE currency = 'USD' LIMIT 1")).toHaveLength(1);
    expect(r.body.data.fx).toEqual({ usdToCad: 1.3712, asOf: "2026-09-17" });
    expect(r.body.data.commissionEarnedByCurrency).toEqual({ USD: 100 });
  });
  it("starts the rate worker", async () => {
    const boot = await bootIndex();
    try {
      await boot.workersDone();
      expect(boot.workerCalls.get("startFxRateWorker")).toEqual([[boot.pool]]);
    } finally { boot.restore(); }
  });
});
