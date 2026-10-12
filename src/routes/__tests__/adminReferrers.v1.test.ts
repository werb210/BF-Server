// BF_SERVER_ADMIN_REFERRERS_v1
import express from "express";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";
import { bearer } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db.js")>()),
  pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => undefined }) },
  runQuery: queryMock,
}));

const ROW = { id: "r-1", first_name: "Rita", referrals_count: 3, matched_count: 1, total_accrued: 200, total_paid: 0 };

async function app() {
  const { default: router } = await import("../adminReferrers.js");
  const a = express();
  a.use("/api/admin/referrers", router);
  return a;
}

describe("admin referrers (v1)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([[/WHERE u\.role = 'Referrer'/, { rows: [ROW] }]]));
  });

  it("lists BF referrers with rollups", async () => {
    const res = await request(await app()).get("/api/admin/referrers").set("Authorization", bearer("Staff"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ referrers: [ROW] });
    const sql = String(callsMatching(queryMock, /WHERE u\.role = 'Referrer'/)[0]![0]);
    expect(sql).toContain("AS referrals_count");
    expect(sql).toContain("AS matched_count");
    expect(sql).toContain("WHERE c.referrer_id = u.id AND c.silo = 'BF'");
  });

  it("is staff-gated", async () => {
    const a = await app();
    expect((await request(a).get("/api/admin/referrers")).status).toBe(401);
    expect((await request(a).get("/api/admin/referrers").set("Authorization", bearer("Referrer"))).status).toBe(403);
    expect(callsMatching(queryMock, /WHERE u\.role = 'Referrer'/)).toHaveLength(0);
  });

  it("is mounted at /admin/referrers", async () => {
    const { API_ROUTE_MOUNTS } = await import("../routeRegistry.js");
    const { default: router } = await import("../adminReferrers.js");
    const mounts = API_ROUTE_MOUNTS.filter((m) => m.path === "/admin/referrers");
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.router).toBe(router);
  }, 120_000); // the registry imports every route module
});
