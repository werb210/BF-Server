// BF_SERVER_MAYA_CATALOG_AMOUNTS_v413
// catalog.summary carries real amount/term/rate ranges per category, aggregated so no single lender product
// is identifiable, and tells the model never to quote a number outside this data.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db.js");
  return { ...actual, pool: { query: queryMock } };
});

import mayaStaff from "../routes/mayaStaff.js";

const app = express();
app.use(express.json());
app.use("/api/maya", mayaStaff);
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const catalog = (body: Record<string, unknown> = {}) => request(app).post("/api/maya/catalog-summary").set("Authorization", svc()).send(body);

const BY_CATEGORY = [
  { category: "TERM", n: 4, min_amount: "25000", max_amount: "500000", term_min: 6, term_max: 60, term_unit: "months", rate_min_num: "8.5", rate_max_num: "24" },
  { category: "LOC", n: 2, min_amount: null, max_amount: null, term_min: null, term_max: null, term_unit: null, rate_min_num: null, rate_max_num: null },
];

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/FROM lenders WHERE/, { rows: [{ n: 3 }] }],
    [/GROUP BY category/, { rows: BY_CATEGORY }],
    [/FROM lender_products\s+WHERE/, { rows: [{ n: 6 }] }],
  ]));
});

describe("v413 catalog.summary carries real ranges, not just counts", () => {
  it("aggregates amount, term and rate per category", async () => {
    const r = await catalog();
    expect(r.status).toBe(200);
    expect(r.body.byCategory[0]).toEqual({
      category: "TERM", count: 4, min_amount: 25000, max_amount: 500000,
      term_min: 6, term_max: 60, term_unit: "months", rate_min: 8.5, rate_max: 24,
    });
    expect(r.body.byCategory[1]).toMatchObject({ category: "LOC", min_amount: null, max_amount: null, rate_min: null, rate_max: null });
    const [agg] = callsMatching(queryMock, /GROUP BY category/);
    for (const f of ["min_amount", "max_amount", "term_min", "term_max", "rate_min_num", "rate_max_num"]) {
      expect(sqlText(agg[0])).toContain(f);
    }
    expect(r.body.summary).toContain("TERM (4, $25,000 to $500,000)");
    expect(r.body.summary).toContain("LOC (2)");
  });

  it("aggregates so no single lender product is identifiable", async () => {
    const r = await catalog();
    expect(callsMatching(queryMock, /GROUP BY category/)).toHaveLength(1);
    for (const c of queryMock.mock.calls) {
      expect(sqlText(c[0])).not.toContain("lenders.name");
      expect(sqlText(c[0])).not.toMatch(/\bname\b/);
    }
    for (const cat of r.body.byCategory) {
      expect(Object.keys(cat).sort()).toEqual(["category", "count", "max_amount", "min_amount", "rate_max", "rate_min", "term_max", "term_min", "term_unit"]);
    }
  });

  it("tells the model never to quote a number outside this data", async () => {
    const r = await catalog();
    expect(r.body.summary).toContain("Never quote an amount, term or rate that is not in this data");
  });

  it("returns the structured categories alongside the prose summary", async () => {
    const r = await catalog();
    expect(r.body.byCategory).toEqual(r.body.categories);
    expect(r.body.categories).toHaveLength(2);
    expect(typeof r.body.summary).toBe("string");
    expect(r.body).toMatchObject({ ok: true, lenders: 3, products: 6 });
  });
});
