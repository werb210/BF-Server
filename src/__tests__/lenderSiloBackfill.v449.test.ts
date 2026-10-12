// BF_SERVER_LENDER_SILO_v449
// A lender or product row with a NULL silo must still count as BF. The fake database below holds rows with
// silo NULL and only matches them when the query coalesces the column, exactly as Postgres would.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});

import mayaStaff from "../routes/mayaStaff.js";

const root = process.cwd();
const migration = readFileSync(
  path.join(root, "migrations/20260923_lenders_silo_backfill.sql"), "utf8");

const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const catalog = (silo?: string) => request(app).post("/api/maya/catalog-summary").set("Authorization", svc()).send(silo ? { silo } : {});

// Every lender and product row here has silo NULL (pre-backfill data).
const COALESCED = "coalesce(silo, 'BF') = $1";
const onlyIfCoalesced = (rows: unknown[]) => (sql: string, params?: unknown[]) =>
  ({ rows: sql.includes(COALESCED) && params?.[0] === "BF" ? rows : [] });

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM lenders WHERE/, (sql: string, p?: unknown[]) => ({ rows: [{ n: sql.includes(COALESCED) && p?.[0] === "BF" ? 7 : 0 }] })],
    [/GROUP BY category/, onlyIfCoalesced([{ category: "TERM", n: 9, min_amount: "5000", max_amount: "100000", term_min: 6, term_max: 24, term_unit: "months", rate_min_num: "10", rate_max_num: "20" }])],
    [/FROM lender_products\s+WHERE/, (sql: string, p?: unknown[]) => ({ rows: [{ n: sql.includes(COALESCED) && p?.[0] === "BF" ? 9 : 0 }] })],
  ]));
});

describe("v449 silo-filtered lender counts are no longer zero", () => {
  it("backfills both tables", () => {
    expect(migration).toContain("UPDATE lenders         SET silo = 'BF' WHERE silo IS NULL");
    expect(migration).toContain("UPDATE lender_products SET silo = 'BF' WHERE silo IS NULL");
  });

  it("is idempotent, per the project rule", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
    expect(migration.match(/WHERE silo IS NULL/g)?.length).toBe(2);
  });

  it("no silo-filtered lender query compares the raw column any more", async () => {
    const r = await catalog();
    expect(r.status).toBe(200);
    expect(r.body.lenders).toBe(7);
    expect(r.body.products).toBe(9);
    for (const c of queryMock.mock.calls) {
      expect(sqlText(c[0])).not.toMatch(/FROM lenders? ?_?p?r?o?d?u?c?t?s? WHERE silo = \$1/);
    }
  });

  it("the byCategory query is covered too, not just the counts", async () => {
    const r = await catalog();
    expect(r.body.categories).toHaveLength(1);
    expect(r.body.categories[0]).toMatchObject({ category: "TERM", count: 9 });
    const silod = queryMock.mock.calls.filter((c) => sqlText(c[0]).includes(COALESCED));
    expect(silod.length).toBeGreaterThanOrEqual(3);
    expect(callsMatching(queryMock, /GROUP BY category/)[0][1]).toEqual(["BF"]);
  });

  it("a NULL-silo lender is not counted for another silo", async () => {
    const r = await catalog("BI");
    expect(r.body.lenders).toBe(0);
    expect(r.body.products).toBe(0);
    expect(r.body.categories).toEqual([]);
  });
});
