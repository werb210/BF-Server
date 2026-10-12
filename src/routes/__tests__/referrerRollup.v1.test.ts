// BF_SERVER_REFERRER_ROLLUP_v1
import express from "express";
import request from "supertest";
import { describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db.js")>()),
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

describe("referrer commission rollup", () => {
  it("returns total_accrued and total_paid summed from referral_conversions", async () => {
    queryMock.mockImplementation(answerBySql([[/WHERE u\.role = 'Referrer'/, { rows: [{ id: "r-1", total_accrued: "120.00", total_paid: "80.00" }] }]]));
    const { default: router } = await import("../adminReferrers.js");
    const app = express();
    app.use("/api/admin/referrers", router);
    const res = await request(app).get("/api/admin/referrers").set("Authorization", bearer("Admin"));
    expect(res.status).toBe(200);
    expect(res.body.referrers[0]).toMatchObject({ total_accrued: "120.00", total_paid: "80.00" });
    const sql = String(callsMatching(queryMock, /WHERE u\.role = 'Referrer'/)[0]![0]);
    expect(sql).toContain("FROM referral_conversions rcv");
    expect(sql).toContain("WHERE rcv.referrer_id = u.id");
    expect(sql).toMatch(/SUM\(rcv\.credit_amount\) FILTER \(WHERE rcv\.status = 'credited'\), 0\) AS total_accrued/);
    expect(sql).toMatch(/SUM\(rcv\.credit_amount\) FILTER \(WHERE rcv\.status = 'paid'\), 0\)\s+AS total_paid/);
  });
});
