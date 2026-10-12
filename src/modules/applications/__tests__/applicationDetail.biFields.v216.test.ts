// BF_SERVER_BLOCK_v216_APPLICATION_DETAIL_BI_FIELDS_v1
// Regression: GET /api/applications/:id must return the BI
// handoff columns when set, and null when not.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db", async () => {
  const actual = await vi.importActual<typeof import("../../../db.js")>("../../../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function getDetail(row: Record<string, unknown>) {
  queryMock.mockImplementation(answerBySql([[/FROM applications a WHERE a\.id::text/, { rows: [row] }]]));
  const router = (await import("../applications.routes.js")).default;
  const { errorHandler } = await import("../../../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return request(app).get(`/api/applications/${APP_ID}`).set("Authorization", `Bearer ${token()}`);
}

beforeEach(() => { queryMock.mockReset(); });

describe("BF_SERVER_BLOCK_v216_APPLICATION_DETAIL_BI_FIELDS_v1", () => {
  it("SELECT on GET /api/applications/:id includes the three BI handoff columns", async () => {
    const res = await getDetail({ id: APP_ID, silo: "BF", bi_application_id: null, bi_public_id: null, bi_completion_url: null });
    expect(res.status).toBe(200);
    const [sql, params] = callsMatching(queryMock, /FROM applications a WHERE a\.id::text/)[0]!;
    expect(sqlText(sql)).toMatch(/a\.bi_application_id/);
    expect(sqlText(sql)).toMatch(/a\.bi_public_id/);
    expect(sqlText(sql)).toMatch(/a\.bi_completion_url/);
    expect(params).toEqual([APP_ID]);
  });

  it("returns the BI handoff values when set", async () => {
    const bi = { bi_application_id: "bi-app-1", bi_public_id: "PUB123", bi_completion_url: "https://insurance.example/complete/PUB123" };
    const res = await getDetail({ id: APP_ID, silo: "BF", ...bi });
    expect(res.status).toBe(200);
    expect(res.body.data.application).toMatchObject(bi);
  });

  it("returns nulls for an application that did not opt into PGI", async () => {
    const res = await getDetail({ id: APP_ID, silo: "BF", bi_application_id: null, bi_public_id: null, bi_completion_url: null });
    expect(res.body.data.application).toMatchObject({ bi_application_id: null, bi_public_id: null, bi_completion_url: null });
  });
});
