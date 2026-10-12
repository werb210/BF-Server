// BF_SERVER_UNCLAIMED_APP_OWNERSHIP_v10
// BF_SERVER_v784_CLIENT_OWNERSHIP - the guard moved out of src/routes/client/index.ts
// into src/auth/clientApplicationOwnership.ts and no longer lets token-less
// requests through; the mid-wizard (unclaimed) rule is unchanged.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: queryMock, connect: vi.fn() }, runQuery: queryMock, dbQuery: queryMock }));
import { checkApplicationAccess } from "../auth/clientApplicationOwnership.js";
import { classifyClaims } from "../auth/principal.js";
import clientRouter from "../routes/client/index.js";

const APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHONE = "+17805550142";
const COUNTS_SQL = /AS total,[\s\S]*AS mine,[\s\S]*AS known/;
const client = classifyClaims({ sub: "client:" + PHONE, role: "client", phone: PHONE });
const token = "Bearer " + jwt.sign({ sub: "client:" + PHONE, role: "client", phone: PHONE }, process.env.JWT_SECRET as string);

function counts(c: { total: number; mine: number; known: number }) {
  queryMock.mockImplementation(answerBySql([
    [COUNTS_SQL, { rows: [c] }],
    [/SELECT id::text AS id FROM applications WHERE lower\(id::text\) = ANY/, { rows: [{ id: APP_ID }] }],
  ]));
}

const app = express();
app.use(express.json());
app.use("/api/client", clientRouter);

beforeEach(() => { queryMock.mockReset(); counts({ total: 1, mine: 0, known: 0 }); });

describe("mid-wizard application ownership", () => {
  it("counts how many linked contacts actually have a phone", async () => {
    await checkApplicationAccess(client, APP_ID);
    const [sql, params] = callsMatching(queryMock, COUNTS_SQL)[0] as [string, unknown[]];
    expect(sql).toContain("FROM app_phones WHERE p10 <> ''");
    expect(sql).toMatch(/FROM app_phones WHERE p10 <> ''\)\s+AS known/);
    expect(params).toEqual([APP_ID, "7805550142"]);
  });

  it("only forbids when the application has a known owner that is not you", async () => {
    counts({ total: 1, mine: 0, known: 0 }); // unclaimed, mid-wizard
    expect(await checkApplicationAccess(client, APP_ID)).toMatchObject({ ok: true });
    counts({ total: 1, mine: 1, known: 2 }); // yours (e.g. a partner on a joint file)
    expect(await checkApplicationAccess(client, APP_ID)).toMatchObject({ ok: true });
    counts({ total: 1, mine: 0, known: 1 }); // somebody else's
    expect(await checkApplicationAccess(client, APP_ID)).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("the client router runs the shared guard", async () => {
    counts({ total: 1, mine: 0, known: 1 });
    const other = await request(app).get(`/api/client/messages/typing?applicationId=${APP_ID}`).set("Authorization", token);
    expect(other.status).toBe(403);
    expect(other.body).toEqual({ error: "forbidden" });
    counts({ total: 1, mine: 0, known: 0 });
    const unclaimed = await request(app).get(`/api/client/messages/typing?applicationId=${APP_ID}`).set("Authorization", token);
    expect(unclaimed.status).toBe(200);
  });

  it("no longer treats a missing or invalid token as capability access", async () => {
    expect(await checkApplicationAccess(null, APP_ID)).toEqual({ ok: false, status: 401, error: "unauthorized" });
    const none = await request(app).get(`/api/client/messages/typing?applicationId=${APP_ID}`);
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: "unauthorized" });
    const bad = await request(app).get(`/api/client/messages/typing?applicationId=${APP_ID}`).set("Authorization", "Bearer not-a-jwt");
    expect(bad.status).toBe(401);
  });
});
