import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { callsMatching, sqlText } from "./helpers/answerBySql.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";

const { queryMock, addMessageMock } = vi.hoisted(() => ({ queryMock: vi.fn(), addMessageMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  return { ...real, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: addMessageMock }));

import mayaRoutes from "../routes/maya.js";
import mayaStaff from "../routes/mayaStaff.js";

const staffApp = express(); staffApp.use(express.json()); staffApp.use("/api/maya", mayaStaff);
const proxy = express(); proxy.use(express.json()); proxy.use("/api/maya", mayaRoutes);
const svc = "Bearer " + jwt.sign({ kind: "service", source: "agent" }, process.env.JWT_SECRET as string);

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown) => {
    const s = sqlText(sql);
    if (s.includes("GROUP BY 1, 2")) return { rows: [{ category: "LOC", rate_kind: "apr", product_count: 1, amount_min: 50000, amount_max: 500000, interest_min: 8, interest_max: 14 }] };
    if (s.includes("FROM lender_products lp")) return { rows: [{ id: "p1", name: "Flex LOC", category: "LOC", country: "CA", amount_min: 50000, amount_max: 500000, interest_min: "8", interest_max: "14", rate_type: "variable", rate_kind: "apr", required_documents: null, lender_name: "Bank A" }] };
    return { rows: [], rowCount: 1 };
  });
  addMessageMock.mockReset();
  addMessageMock.mockResolvedValue(undefined);
  process.env.MAYA_URL = "http://maya.test";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reply: "Sure." }), { status: 200 })));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.MAYA_URL; });

describe("maya lender-products live-schema fix", () => {
  async function products() {
    const r = await request(staffApp).post("/api/maya/staff/lender-products").set("Authorization", svc).send({ category: "LOC", amount: 100000 });
    expect(r.status).toBe(200);
    return r;
  }

  it("no longer selects columns that do not exist on lender_products", async () => {
    await products();
    const sql = callsMatching(queryMock, /FROM lender_products lp/).map((c) => sqlText(c[0])).join("\n");
    expect(sql).not.toBe("");
    for (const gone of ["lp.region", "lp.term_min", "lp.term_max", "lp.term_unit"]) expect(sql).not.toContain(gone);
  });

  it("still returns the real product economics", async () => {
    const r = await products();
    expect(r.body.products[0]).toMatchObject({ product: "Flex LOC", amountMin: 50000, amountMax: 500000, interestMin: "8", interestMax: "14" });
    expect(r.body.ranges[0]).toMatchObject({ amountMin: 50000, amountMax: 500000, interestMin: 8, interestMax: 14 });
    const [list] = callsMatching(queryMock, /FROM lender_products lp[\s\S]*LIMIT 50/);
    expect(sqlText(list![0])).toContain("lp.interest_min, lp.interest_max");
    expect(sqlText(list![0])).toContain("lp.amount_min, lp.amount_max");
  });

  it("guards transcript persistence to valid uuid session ids", async () => {
    const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
    await request(proxy).post("/api/maya/message").send({ message: "hi", sessionId: UUID });
    expect(callsMatching(queryMock, /insert into chat_sessions/i)[0]![1]).toEqual([UUID]);
    expect(addMessageMock).toHaveBeenCalledWith({ sessionId: UUID, role: "user", message: "hi" });
    expect(addMessageMock).toHaveBeenCalledWith({ sessionId: UUID, role: "ai", message: "Sure." });

    // BF_SERVER_BLOCK_v567 - a non-uuid session id maps to a stable uuid v5 instead of breaking the insert.
    queryMock.mockClear();
    await request(proxy).post("/api/maya/message").send({ message: "hi", sessionId: "client-abc" });
    await request(proxy).post("/api/maya/message").send({ message: "again", sessionId: "client-abc" });
    const ids = callsMatching(queryMock, /insert into chat_sessions/i).map((c) => (c[1] as string[])[0]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[0]).not.toBe("client-abc");
  });
});
