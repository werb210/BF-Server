// BF_SERVER_CATALOG_COLUMNS_v429
// catalog.summary must only use columns lender_products actually has. The fake database below rejects the
// column names v413 invented, the way Postgres does, so a regression surfaces as catalog_summary_failed.
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

const migrations = readFileSync(
  path.join(process.cwd(), "migrations/2026_05_24_v647_lender_products_seed.sql"), "utf8");

const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const catalog = () => request(app).post("/api/maya/catalog-summary").set("Authorization", svc()).send({});
const aggSql = () => sqlText(callsMatching(queryMock, /GROUP BY category/)[0][0]);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/min_term_months|max_term_months/, new Error('column "min_term_months" does not exist')],
    [/FROM lenders WHERE/, { rows: [{ n: 1 }] }],
    [/GROUP BY category/, { rows: [{ category: "TERM", n: 1, min_amount: "10000", max_amount: "90000", term_min: 3, term_max: 36, term_unit: "months", rate_min_num: "9", rate_max_num: "19.5" }] }],
    [/FROM lender_products\s+WHERE/, { rows: [{ n: 1 }] }],
  ]));
});

describe("v429 catalog.summary uses columns that exist", () => {
  it("no longer references the names v413 invented", async () => {
    const r = await catalog();
    expect(r.status).toBe(200);
    for (const c of queryMock.mock.calls) {
      for (const bad of ["min_term_months", "max_term_months"]) expect(sqlText(c[0])).not.toContain(bad);
    }
  });

  it("uses the real term columns", async () => {
    const r = await catalog();
    expect(aggSql()).toContain("term_min");
    expect(aggSql()).toContain("term_max");
    expect(r.body.categories[0]).toMatchObject({ term_min: 3, term_max: 36, term_unit: "months" });
    expect(migrations).toContain("term_min");
  });

  it("uses the numeric rate columns, not the TEXT ones", async () => {
    const r = await catalog();
    expect(aggSql()).toContain("rate_min_num");
    expect(aggSql()).toContain("rate_max_num");
    expect(r.body.categories[0]).toMatchObject({ rate_min: 9, rate_max: 19.5 });
    expect(migrations).toContain("rate_min_num     NUMERIC");
  });

  it("keeps the amount columns that were already correct", async () => {
    const r = await catalog();
    expect(aggSql()).toContain("min(NULLIF(min_amount, 0))");
    expect(aggSql()).toContain("max(NULLIF(max_amount, 0))");
    expect(r.body.categories[0]).toMatchObject({ min_amount: 10000, max_amount: 90000 });
  });
});
