// Maya catalog summary: POST /catalog-summary returns lender and product counts, never lender names.
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

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/count\(\*\)::int AS n FROM lenders/, { rows: [{ n: 12, name: "Secret Lender Inc" }] }],
    [/count\(\*\)::int AS n FROM lender_products/, { rows: [{ n: 40 }] }],
    [/GROUP BY category/, { rows: [{ category: "TERM", n: 40, min_amount: null, max_amount: null }] }],
  ]));
});

describe("Maya catalog summary", () => {
  it("exposes /catalog-summary returning counts only (no names)", async () => {
    const r = await request(app).post("/api/maya/catalog-summary").set("Authorization", svc()).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, lenders: 12, products: 40 });
    expect(callsMatching(queryMock, "count(*)::int AS n FROM lenders")).toHaveLength(1);
    expect(callsMatching(queryMock, "count(*)::int AS n FROM lender_products")).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain("Secret Lender Inc");
    for (const c of queryMock.mock.calls) expect(sqlText(c[0])).not.toMatch(/\bname\b/);
  });

  it("requires the Maya service token", async () => {
    const r = await request(app).post("/api/maya/catalog-summary").send({});
    expect(r.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
