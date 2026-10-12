// BF_SERVER_LENDER_SELF_NOTNULL_GUARD_v1 - a blank value bound for a NOT NULL lenders column is
// skipped (existing value kept), never written as NULL; nullable columns stay clearable.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching, type SqlRule } from "../../__tests__/helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: h.query, connect: vi.fn() }, runQuery: h.query, dbQuery: h.query }));

const LENDER_ID = "61616161-6161-4161-8161-616161616161";
const lender = "Bearer " + jwt.sign({ sub: "lender:" + LENDER_ID, role: "Lender", lenderId: LENDER_ID }, process.env.JWT_SECRET as string);
const NOT_NULL_SQL = /FROM information_schema\.columns/;
const CURRENT = { id: LENDER_ID, name: "Acme Capital", country: "CA", website: "https://acme.test" };

// A fresh router per test: the NOT NULL column set is cached for the life of the module.
async function freshApp(rules: SqlRule[]) {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    ...rules,
    [/UPDATE lenders/, { rows: [{ ...CURRENT, website: null }] }],
    [/FROM lenders\s+WHERE id::text = \$1/, { rows: [CURRENT] }],
  ]));
  vi.resetModules();
  const lenderSelf = (await import("../lenderSelf.js")).default;
  const app = express();
  app.use(express.json());
  app.use("/api/lender", lenderSelf);
  return app;
}

let warn: ReturnType<typeof vi.spyOn>;
const lenderWarnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.startsWith("[lender-self]")).join("\n");
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe("lender self-service never writes NULL into a NOT NULL column", () => {
  it("discovers NOT NULL columns at runtime", async () => {
    const app = await freshApp([[NOT_NULL_SQL, { rows: [{ column_name: "name" }, { column_name: "submission_email" }] }]]);
    const r = await request(app).patch("/api/lender/me").set("Authorization", lender).send({ submission_email: "", website: "https://new.test" });
    expect(r.status).toBe(200);
    const sql = String(callsMatching(h.query, NOT_NULL_SQL)[0][0]);
    expect(sql).toContain("is_nullable = 'NO'");
    expect(sql).toContain("table_name = 'lenders'");
    // submission_email is NOT NULL in this (discovered) schema, so it is kept, not nulled.
    expect(r.body.skipped).toBeUndefined();
    const [upd, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(upd).toMatch(/SET website = \$2, updated_at/);
    expect(params).toEqual([LENDER_ID, "https://new.test"]);
    // The lookup runs once and is cached.
    await request(app).patch("/api/lender/me").set("Authorization", lender).send({ website: "https://x.test" });
    expect(callsMatching(h.query, NOT_NULL_SQL)).toHaveLength(1);
  });

  it("falls back to the known NOT NULL set if the lookup fails", async () => {
    // A failed lookup must cost a skipped field, never a 500.
    const app = await freshApp([[NOT_NULL_SQL, new Error("permission denied for information_schema")]]);
    const r = await request(app).patch("/api/lender/me").set("Authorization", lender)
      .send({ name: "", country: "", status: "", active: "", has_broker_agreement: "", website: "https://y.test" });
    expect(r.status).toBe(200);
    const [upd, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    for (const col of ["name", "country"]) expect(upd).not.toMatch(new RegExp(`\\b${col} = \\$`));
    expect(params).toEqual([LENDER_ID, "https://y.test"]);
    expect(lenderWarnings()).toContain("name, country");
  });

  it("skips blank values bound for NOT NULL columns rather than nulling them", async () => {
    const app = await freshApp([[NOT_NULL_SQL, { rows: [{ column_name: "name" }, { column_name: "country" }] }]]);
    await request(app).patch("/api/lender/me").set("Authorization", lender).send({ name: "   ", country: "US" });
    const [upd, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(upd).toMatch(/SET country = \$2/);
    expect(upd).not.toContain("name = $");
    expect(params).toEqual([LENDER_ID, "US"]);
  });

  it("leaves nullable columns clearable", async () => {
    // A lender must still be able to blank out an optional field such as
    // website or announcement; only NOT NULL columns are protected.
    const app = await freshApp([[NOT_NULL_SQL, { rows: [{ column_name: "name" }] }]]);
    const r = await request(app).patch("/api/lender/me").set("Authorization", lender).send({ website: "", announcement: "" });
    expect(r.status).toBe(200);
    const [upd, params] = callsMatching(h.query, /UPDATE lenders/)[0] as [string, unknown[]];
    expect(upd).toMatch(/SET website = \$2, announcement = \$3/);
    expect(params).toEqual([LENDER_ID, null, null]);
  });

  it("reports which fields were kept instead of failing the save", async () => {
    const app = await freshApp([[NOT_NULL_SQL, { rows: [{ column_name: "name" }, { column_name: "country" }] }]]);
    const r = await request(app).patch("/api/lender/me").set("Authorization", lender).send({ name: "", country: "" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", data: CURRENT, skipped: ["name", "country"] });
    expect(callsMatching(h.query, /UPDATE lenders/)).toHaveLength(0);
    expect(lenderWarnings()).toContain("keeping existing values: name, country");
  });
});
