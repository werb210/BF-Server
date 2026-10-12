// BF_SERVER_BLOCK_v549_LOCK_APPLICATION_STAGE
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "../../../__tests__/helpers/answerBySql.js";

const APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "+15875550123";
const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../db.js", async (orig) => {
  const real: any = await orig();
  const q = (sql: unknown, params?: unknown[]) => h.query(sql, params);
  const pool = { query: q, connect: async () => ({ query: q, release: () => undefined }) };
  return { ...real, dbQuery: q, runQuery: q, query: q, pool, db: pool, default: pool };
});

import clientRouter from "../index.js";

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);
const token = (phone: string) => "Bearer " + jwt.sign({ sub: "client:" + phone, role: "client", phone, isClient: true }, process.env.JWT_SECRET as string, { algorithm: "HS256" });
const STAGE_READ = /select pipeline_state, status, metadata from applications/;

beforeEach(() => {
  h.query.mockReset();
  h.query.mockImplementation(answerBySql([
    // The router-level guard does not recognise the id, so the route's own check is what protects it.
    [/FROM applications WHERE lower\(id::text\) = ANY/, { rows: [] }],
    [/SELECT COUNT\(\*\)::text AS n FROM app_phones WHERE p10 = \$2/, (_s: string, p?: unknown[]) => ({ rows: [{ n: p?.[0] === APP && p?.[1] === OWNER.slice(-10) ? "1" : "0" }] })],
    [STAGE_READ, { rows: [{ pipeline_state: "In Review", status: "submitted", metadata: { applicant: { sin: "999" } } }] }],
  ]));
});

describe("v549 application-stage answers only the owner", () => {
  it("tells anyone without a session the file does not exist, without reading it", async () => {
    const r = await request(app).get(`/api/client/application-stage?applicationId=${APP}`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ found: false });
    expect(callsMatching(h.query, STAGE_READ)).toHaveLength(0);
  });

  it("tells a signed-in client who does not own it the same", async () => {
    const r = await request(app).get(`/api/client/application-stage?applicationId=${APP}`).set("Authorization", token("+15875550199"));
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ found: false });
    expect(callsMatching(h.query, STAGE_READ)).toHaveLength(0);
  });

  it("checks ownership before reading the file, and the owner gets the stage", async () => {
    const r = await request(app).get(`/api/client/application-stage?applicationId=${APP}`).set("Authorization", token(OWNER));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ found: true, pipeline_state: "In Review", status: "submitted" });
    const sqls = h.query.mock.calls.map((c) => String(c[0]));
    const own = sqls.findIndex((s) => s.includes("FROM app_phones WHERE p10 = $2"));
    const read = sqls.findIndex((s) => STAGE_READ.test(s));
    expect(own).toBeGreaterThan(-1);
    expect(own).toBeLessThan(read);
  });
});
