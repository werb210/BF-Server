// BF_SERVER_REFERRER_PAYOUT_v1
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db.js")>()),
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

const mig = readFileSync(path.join(process.cwd(), "migrations/2026_07_11_referral_conversions_paid_at.sql"), "utf8");
const PAY = /UPDATE referral_conversions/;

async function app() {
  const { default: router } = await import("../adminReferrers.js");
  const a = express();
  a.use("/api/admin/referrers", router);
  return a;
}

describe("referrer payout", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[PAY, { rows: [{ paid_count: 2, paid_amount: "150.50" }] }]]));
  });

  it("migration adds paid_at idempotently", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ");
  });

  it("admin-only pay route flips credited -> paid and stamps paid_at", async () => {
    const res = await request(await app()).post("/api/admin/referrers/ref-1/pay").set("Authorization", bearer("Admin"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", paidCount: 2, paidAmount: 150.5 });
    const pay = callsMatching(queryMock, PAY);
    expect(pay).toHaveLength(1);
    expect(pay[0]![1]).toEqual(["ref-1"]);
    const sql = String(pay[0]![0]);
    expect(sql).toContain("SET status = 'paid', paid_at = now()");
    expect(sql).toContain("WHERE referrer_id::text = $1 AND status = 'credited'");
  });

  it("staff who are not admins cannot pay out", async () => {
    const res = await request(await app()).post("/api/admin/referrers/ref-1/pay").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(403);
    expect(callsMatching(queryMock, PAY)).toHaveLength(0);
  });
});
