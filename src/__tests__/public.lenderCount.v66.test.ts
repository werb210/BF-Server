// BF_SERVER_v66_LENDER_COUNT - GET /api/public/lender-count
import { beforeEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, pool, db: pool, default: pool, dbQuery: q, runQuery: q, query: q };
});

import publicRoutes from "../routes/public.js";

const app = express();
app.use("/api/public", publicRoutes);
const get = () => request(app).get("/api/public/lender-count").timeout(3000);

beforeEach(() => { h.query.mockReset(); });

describe("BF_SERVER_v66_LENDER_COUNT", () => {
  it("serves GET /lender-count with the ok() envelope", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders WHERE COALESCE\(active, true\) = true/, { rows: [{ count: "42" }] }]]));
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", data: { count: 42 } });
  });

  it("counts only active lenders", async () => {
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ count: "7" }] }]]));
    await get();
    const calls = callsMatching(h.query, /FROM lenders/);
    expect(calls).toHaveLength(1);
    expect(sqlText(calls[0]![0])).toMatch(/SELECT COUNT\(\*\)::text AS count FROM lenders WHERE COALESCE\(active, true\) = true/);
  });

  it("falls back to a plain count when the active filter fails", async () => {
    h.query.mockImplementation(answerBySql([
      [/COALESCE\(active, true\)/, new Error('column "active" does not exist')],
      [/FROM lenders/, { rows: [{ count: "9" }] }],
    ]));
    const r = await get();
    expect(r.body).toEqual({ status: "ok", data: { count: 9 } });
  });

  it("falls back to count: 0 on any failure (no exceptions surface)", async () => {
    h.query.mockImplementation(async () => { throw new Error("db down"); });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", data: { count: 0 } });
    h.query.mockImplementation(answerBySql([[/FROM lenders/, { rows: [{ count: "not a number" }] }]]));
    expect((await get()).body).toEqual({ status: "ok", data: { count: 0 } });
  });
});
