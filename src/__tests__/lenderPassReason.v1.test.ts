import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching, sqlText } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db", async () => {
  const actual = await vi.importActual<typeof import("../db.js")>("../db");
  return { ...actual, pool: { query: queryMock }, runQuery: queryMock, dbQuery: queryMock };
});

const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/2026_07_31_v2831_lender_pass_reason.sql", import.meta.url)),
  "utf-8",
);

const APP_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LENDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LENDER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const token = () => jwt.sign({ sub: "00000000-0000-4000-8000-0000000000b1", role: "Staff", tokenVersion: 0, tv: 0 }, process.env.JWT_SECRET as string);

async function buildApp() {
  const router = (await import("../modules/applications/applications.routes.js")).default;
  const { errorHandler } = await import("../middleware/errors.js");
  const app = express();
  app.use(express.json());
  app.use("/api/applications", router);
  app.use(errorHandler);
  return app;
}

function answers(existingOrdinal: number | null = null) {
  return answerBySql([
    [/row_number\(\) OVER/, { rows: [{ lender_id: LENDER_A, ordinal: "1" }, { lender_id: LENDER_B, ordinal: "2" }] }],
    [/SELECT ordinal FROM application_lender_responses/, { rows: existingOrdinal == null ? [] : [{ ordinal: existingOrdinal }] }],
    [/SELECT contact_id FROM applications/, { rows: [{ contact_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }] }],
  ]);
}

const pass = async (lenderId: string, reason = "insufficient time in business") =>
  request(await buildApp()).post(`/api/applications/${APP_ID}/lender-response`).set("Authorization", `Bearer ${token()}`).send({ lenderId, reason });

const bubbleCall = () => callsMatching(queryMock, /INSERT INTO communications_messages/)[0];

beforeEach(() => { queryMock.mockReset(); queryMock.mockImplementation(answers()); });

describe("BF_SERVER_LENDER_PASS_REASON_v1", () => {
  it("creates the table idempotently with one response per lender", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS application_lender_responses");
    expect(migration).toContain("UNIQUE (application_id, lender_id)");
  });

  it("orders lenders by when the package actually went out", async () => {
    const res = await pass(LENDER_B);
    expect(res.status).toBe(200);
    expect(res.body.data.ordinal).toBe(2);
    const [sql, params] = callsMatching(queryMock, /row_number\(\) OVER/)[0]!;
    expect(sqlText(sql)).toContain("row_number() OVER (ORDER BY MIN(sent_at) ASC");
    expect(sqlText(sql)).toContain("sent_at IS NOT NULL");
    expect(params).toEqual([APP_ID]);
  });

  it("freezes the ordinal so later sends cannot renumber old bubbles", async () => {
    queryMock.mockImplementation(answers(1));
    const res = await pass(LENDER_B);
    expect(res.status).toBe(200);
    expect(res.body.data.ordinal).toBe(1);
    const [, params] = callsMatching(queryMock, /INSERT INTO application_lender_responses/)[0]!;
    expect((params as unknown[])[2]).toBe(1);
    expect(String((bubbleCall()![1] as unknown[])[3])).toMatch(/^Lender 1 will pass/);
  });

  it("refuses a lender that never received the package", async () => {
    const res = await pass("99999999-9999-4999-8999-999999999999");
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("No package was sent to that lender.");
    expect(callsMatching(queryMock, /INSERT INTO application_lender_responses/)).toHaveLength(0);
    expect(bubbleCall()).toBeUndefined();
  });

  it("tells the client the ordinal and never the lender", async () => {
    // BF_SERVER_PASS_ORDINAL_v127 - wording changed in v124, the contract did not.
    const res = await pass(LENDER_B, "insufficient time in business");
    expect(res.status).toBe(200);
    expect((bubbleCall()![1] as unknown[])[3]).toBe("Lender 2 will pass, due to insufficient time in business");
  });

  it("still never names the lender in the client bubble", async () => {
    await pass(LENDER_B);
    const [sql, params] = bubbleCall()!;
    expect(sqlText(sql)).not.toMatch(/lender_name|lenderName/);
    for (const p of params as unknown[]) expect(String(p)).not.toContain(LENDER_B);
    // The route never even loads the lender's name.
    expect(callsMatching(queryMock, /FROM lenders/)).toHaveLength(0);
  });

  it("both routes require staff auth", async () => {
    const app = await buildApp();
    const post = await request(app).post(`/api/applications/${APP_ID}/lender-response`).send({ lenderId: LENDER_A, reason: "x" });
    expect(post.status).toBe(401);
    const get = await request(app).get(`/api/applications/${APP_ID}/lender-responses`);
    expect(get.status).toBe(401);
    expect(callsMatching(queryMock, /application_lender_responses/)).toHaveLength(0);
    const ok = await request(app).get(`/api/applications/${APP_ID}/lender-responses`).set("Authorization", `Bearer ${token()}`);
    expect(ok.status).toBe(200);
  });
});
