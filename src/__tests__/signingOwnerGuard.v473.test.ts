// BF_SERVER_BLOCK_v473_SIGNING_OWNER_v1
import { describe, it, expect, beforeAll, vi } from "vitest";
import jwt from "jsonwebtoken";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";
import { makeSigningOwnerGuard } from "../routes/client/signingOwner.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});
vi.mock("../signnow/embeddedSigningSession.js", async (orig) => ({ ...(await orig<any>()), getOrCreateEmbeddedSigningSession: h.session }));

import clientRouter from "../routes/client/index.js";
import mayaStaff from "../routes/mayaStaff.js";

const SECRET = "test-secret-v473-signing";
beforeAll(() => { process.env.JWT_SECRET = SECRET; });

function run(guard: any, headers: Record<string, string>, applicationId = "app-1") {
  const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
  const next = vi.fn();
  return guard({ query: { applicationId }, headers }, res, next).then(() => ({ res, next }));
}
const bearer = (claims: Record<string, unknown>) => ({ authorization: `Bearer ${jwt.sign(claims, SECRET)}` });

describe("v473 signing-session owner guard", () => {
  it("refuses a request with no login", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 1 }] })), {});
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses a token with no phone claim", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 1 }] })), bearer({ userId: "u1" }));
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
  it("refuses a signed-in client whose phone is not on the application", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => ({ rows: [{ mine: 0 }] })), bearer({ phone: "+1 (403) 555-0100" }));
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
  it("lets the applicant through and matches on the last ten digits", async () => {
    let params: unknown[] = [];
    const { next } = await run(makeSigningOwnerGuard(async (_t, p) => { params = p ?? []; return { rows: [{ mine: 1 }] }; }), bearer({ phone: "+1 (403) 555-0100" }));
    expect(next).toHaveBeenCalledOnce();
    expect(params).toEqual(["app-1", "4035550100"]);
  });
  it("fails closed when the ownership query errors", async () => {
    const { res, next } = await run(makeSigningOwnerGuard(async () => { throw new Error("db down"); }), bearer({ phone: "4035550100" }));
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
  it("is mounted on /signing-session", async () => {
    h.session.mockReset();
    h.session.mockResolvedValue({ status: "ready", url: "https://signnow.test/s/1" });
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      // Not recognised by the router-wide guard, so the signing guard is what answers.
      [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
      [/SELECT COUNT\(\*\)::int AS mine FROM app_phones/, (_s: string, p?: unknown[]) => ({ rows: [{ mine: p?.[0] === APP && p?.[1] === OWNER.slice(-10) ? 1 : 0 }] })],
      // BF_SERVER_v858_PARTNER_SIGNING - the signed-in phone is the applicant's (Owner 1), so Owner 1's session opens.
      [/AS v858_embedded/, { rows: [{ signnow_app_signed_at: null, v858_embedded: null, v858_queue: null }] }],
      [/AS v858_role/, { rows: [{ v858_role: "applicant", phone: OWNER, email: "owner@x.test" }] }],
    ]));
    const app = express();
    app.use(express.json());
    app.use("/api/client", clientRouter);
    const tok = (phone: string) => `Bearer ${jwt.sign({ sub: "client:" + phone, role: "client", phone }, SECRET)}`;
    const none = await request(app).get(`/api/client/signing-session?applicationId=${APP}`);
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: "sign_in_required" });
    const other = await request(app).get(`/api/client/signing-session?applicationId=${APP}`).set("Authorization", tok("+15875550199"));
    expect(other.status).toBe(403);
    expect(h.session).not.toHaveBeenCalled();
    const mine = await request(app).get(`/api/client/signing-session?applicationId=${APP}`).set("Authorization", tok(OWNER));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ status: "ready", url: "https://signnow.test/s/1", signer: { index: 1, isApplicant: true } }); // BF_SERVER_v858_PARTNER_SIGNING
    expect(h.session).toHaveBeenCalledWith(APP);
  });
});

describe("v473 Maya product ranges", () => {
  const SAMPLE = Array.from({ length: 50 }, (_v, i) => ({ id: "p" + i, name: "Product " + i, category: "LOC", amount_min: 10000, amount_max: 50000, rate_kind: "apr", lender_name: "Bank" }));
  const GROUPS = [
    { category: "LOC", rate_kind: "apr", product_count: 70, amount_min: "5000", amount_max: "500000", interest_min: "7.5", interest_max: "24" },
    { category: "LOC", rate_kind: "factor", product_count: 12, amount_min: "10000", amount_max: "250000", interest_min: "1.1", interest_max: "1.45" },
  ];
  async function ask() {
    h.query.mockReset();
    h.query.mockImplementation(answerBySql([
      [/GROUP BY 1, 2/, { rows: GROUPS }],
      [/FROM lender_products lp/, { rows: SAMPLE }],
    ]));
    const app = express();
    app.use(express.json());
    app.use("/api/maya", mayaStaff);
    const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, SECRET);
    return request(app).post("/api/maya/staff/lender-products").set("Authorization", svc).send({ category: "LOC", amount: 40000 });
  }

  it("returns ranges computed over every matching product", async () => {
    const r = await ask();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.products).toHaveLength(50);
    expect(r.body.totalMatching).toBe(82);
    expect(r.body.ranges).toEqual([
      { category: "LOC", rateKind: "apr", productCount: 70, amountMin: 5000, amountMax: 500000, interestMin: 7.5, interestMax: 24 },
      { category: "LOC", rateKind: "factor", productCount: 12, amountMin: 10000, amountMax: 250000, interestMin: 1.1, interestMax: 1.45 },
    ]);
    // The range query has no LIMIT and uses the same filters as the list.
    const [range] = callsMatching(h.query, /GROUP BY 1, 2/);
    expect(sqlText(range![0])).not.toMatch(/LIMIT/);
    expect(range![1]).toEqual(["LOC", null, 40000]);
  });

  it("never mixes rate kinds and tells Maya to quote from ranges", async () => {
    const r = await ask();
    expect(new Set(r.body.ranges.map((g: any) => g.rateKind)).size).toBe(r.body.ranges.length);
    expect(sqlText(callsMatching(h.query, /GROUP BY 1, 2/)[0]![0])).toContain("lower(coalesce(lp.rate_kind, '')) AS rate_kind");
    expect(r.body.summary).toBe("82 matching lender product(s) (listing 50). Quote amount and rate limits from ranges, which cover every matching product - never from the listed sample.");
  });
});
