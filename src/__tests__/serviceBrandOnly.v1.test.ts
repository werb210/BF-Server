// BF_SERVER_BRAND_ONLY_UNSUBSCRIBES_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown[]]> }));
vi.mock("../db.js", () => {
  const query = async (sql: string, params: unknown[] = []) => {
    h.calls.push([sql, params]);
    if (sql.includes("UPDATE email_suppressions")) return { rows: [], rowCount: 2 };
    if (sql.includes("UPDATE contacts c SET marketing_opt_out = false")) return { rows: [{ id: "c1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query, connect: async () => ({ query, release: () => undefined }) }, runQuery: query };
});
vi.mock("../modules/applications/applications.repo.js", () => ({ findActiveDocumentVersion: async () => null }));
vi.mock("../services/smsService.js", () => ({ sendSMS: vi.fn() }));
vi.mock("../services/email/graphSendService.js", () => ({ sendViaGraph: vi.fn() }));

async function app() {
  const { default: router } = await import("../routes/serviceBridge.js");
  const a = express(); a.use(express.json()); a.use("/api/service", router); return a;
}
beforeEach(() => { process.env.BACKEND_SERVICE_TOKEN = "svc-token"; h.calls = []; });

describe("brand-only unsubscribes", () => {
  it("marks the addresses as Boreal Risk Management only and lifts the other businesses' opt-outs", async () => {
    const r = await request(await app()).post("/api/service/suppressions/brand-only").set("x-backend-token", "svc-token")
      .send({ brand: "BI", emails: ["A@x.com", "bad", "a@x.com"] });
    expect(r.body).toEqual({ ok: true, marked: 2, released: 1 });
    const mark = h.calls.find(([s]) => s.includes("UPDATE email_suppressions"))!;
    expect(mark[1]).toEqual([["a@x.com"], "BI"]);
    expect(h.calls.find(([s]) => s.includes("UPDATE contacts"))![0]).toContain("s.brands IS NULL OR coalesce(c.silo, 'BF') = ANY (s.brands)");
  });
  it("needs the service token", async () => {
    const r = await request(await app()).post("/api/service/suppressions/brand-only").send({ brand: "BI", emails: ["a@x.com"] });
    expect(r.status).toBe(401);
  });
});
