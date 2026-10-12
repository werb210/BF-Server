// BF_SERVER_CHANGE_PRODUCT_CATEGORY_v286
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js"; // BF_SERVER_SQL_CONTENT_MOCKS_v762
import { changeProductCategory, normalizeProductCategory, PRODUCT_CATEGORIES } from "../productCategoryChange.js";

const h = vi.hoisted(() => ({
  queryMock: vi.fn(),
  computeAndCacheLenderMatches: vi.fn(async () => undefined),
  readLenderMatchEnvelope: vi.fn(async () => ({ matches: [] })),
  requestProductQuestions: vi.fn(async () => ({ requested: false })),
}));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: h.queryMock }, runQuery: h.queryMock, dbQuery: h.queryMock };
});
vi.mock("../../../services/lenderMatchCache.js", async (orig) => ({
  ...(await orig<typeof import("../../../services/lenderMatchCache.js")>()),
  computeAndCacheLenderMatches: h.computeAndCacheLenderMatches,
  readLenderMatchEnvelope: h.readLenderMatchEnvelope,
}));
vi.mock("../../../services/productQuestions/sendGate.js", async (orig) => ({
  ...(await orig<typeof import("../../../services/productQuestions/sendGate.js")>()),
  requestProductQuestions: h.requestProductQuestions,
}));

describe("product category values", () => {
  it("accepts the match engine's buckets in any casing", () => {
    expect(normalizeProductCategory("term_loan")).toBe("TERM_LOAN");
    expect(normalizeProductCategory("Merchant Cash Advance")).toBe("MERCHANT_CASH_ADVANCE");
    expect(normalizeProductCategory("crypto")).toBeNull();
    expect(PRODUCT_CATEGORIES.map((c) => c.value)).toContain("LINE_OF_CREDIT");
  });
});

describe("changing the category", () => {
  it("sets the column, clears multi-category overrides, keeps history and marks matches stale", async () => {
    const query = vi.fn(answerBySql([
      [/SELECT product_category FROM applications/, { rows: [{ product_category: "MERCHANT_CASH_ADVANCE" }] }],
      [/UPDATE applications/, { rows: [], rowCount: 1 }],
    ]));
    const result = await changeProductCategory(query, "app-1", "TERM_LOAN", "user-1");
    expect(result).toEqual({ from: "MERCHANT_CASH_ADVANCE", to: "TERM_LOAN" });
    const [sql, params] = callsMatching(query, /UPDATE applications/)[0]!;
    expect(sql).toContain("SET product_category = $2");
    expect(sql).toContain("- 'match_categories'");
    expect(sql).toContain("lender_matches_stale = true");
    expect(JSON.parse(String(params[2]))).toMatchObject({ from: "MERCHANT_CASH_ADVANCE", to: "TERM_LOAN", by: "user-1" });
  });
});

describe("wiring: POST /api/applications/:id/product-category", () => {
  const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const STAFF_ID = "00000000-0000-4000-8000-0000000000b1";
  const sign = (extra: Record<string, unknown> = {}) => jwt.sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0, tv: 0, ...extra }, process.env.JWT_SECRET as string);
  const post = async (tok: string, silo = "BF") => {
    h.queryMock.mockImplementation(answerBySql([
      [/select id, silo from applications/, { rows: [{ id: APP_ID, silo }] }],
      [/SELECT product_category FROM applications/, { rows: [{ product_category: "MERCHANT_CASH_ADVANCE" }] }],
    ]));
    const router = (await import("../applications.routes.js")).default;
    const { errorHandler } = await import("../../../middleware/errors.js");
    const app = express();
    app.use(express.json());
    app.use("/api/applications", router);
    app.use(errorHandler);
    return request(app).post(`/api/applications/${APP_ID}/product-category`).set("Authorization", `Bearer ${tok}`).send({ category: "term loan" });
  };
  const categoryWrites = () => callsMatching(h.queryMock, /SET product_category = \$2/);

  beforeEach(() => { h.queryMock.mockReset(); h.computeAndCacheLenderMatches.mockClear(); h.requestProductQuestions.mockClear(); });

  it("checks write permission", async () => {
    const res = await post(sign({ capabilities: ["application:read"] }));
    expect(res.status).toBe(403);
    expect(categoryWrites()).toHaveLength(0);
    expect(h.computeAndCacheLenderMatches).not.toHaveBeenCalled();
  });

  it("checks the silo before changing anything", async () => {
    const res = await post(sign(), "BI");
    expect(res.status).toBe(404);
    expect(categoryWrites()).toHaveLength(0);
    expect(h.computeAndCacheLenderMatches).not.toHaveBeenCalled();
  });

  it("changes the category, then re-matches lenders", async () => {
    const res = await post(sign());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ product_category: "TERM_LOAN", previous_product_category: "MERCHANT_CASH_ADVANCE" });
    const write = categoryWrites();
    expect(write).toHaveLength(1);
    expect(write[0]![1]).toEqual([APP_ID, "TERM_LOAN", expect.any(String)]);
    expect(h.computeAndCacheLenderMatches).toHaveBeenCalledWith(APP_ID);
    const writeOrder = h.queryMock.mock.invocationCallOrder[h.queryMock.mock.calls.findIndex((c) => /SET product_category = \$2/.test(String(c[0])))]!;
    expect(h.computeAndCacheLenderMatches.mock.invocationCallOrder[0]!).toBeGreaterThan(writeOrder);
  });
});
