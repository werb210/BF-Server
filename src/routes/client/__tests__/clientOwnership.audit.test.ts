// BF_SERVER_CLIENT_OWNERSHIP_v1 - the client router's ownership guard let any
// request WITHOUT a token through and only looked at applicationId in the query
// or body, so /application/:id/status, PATCH /applications/:id and
// /messages?applicationId= were readable/writable by anyone holding an id.
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../../db.js", async () => {
  const actual = await vi.importActual<any>("../../../db.js");
  return {
    ...actual,
    pool: { query: queryMock, connect: async () => ({ query: queryMock, release: () => {} }) },
    dbQuery: (sql: string, params?: unknown[]) => queryMock(sql, params),
    runQuery: (sql: string, params?: unknown[]) => queryMock(sql, params),
  };
});

const SECRET = "test-jwt-secret";
const APP = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";
const OWNER_PHONE = "+15555550123";
const sign = (c: Record<string, unknown>) => jwt.sign(c, SECRET, { expiresIn: "5m" });
const owner = sign({ sub: `client:${OWNER_PHONE}`, role: "client", phone: OWNER_PHONE, isClient: true });
const stranger = sign({ sub: "client:+15555550199", role: "client", phone: "+15555550199", isClient: true });
const staff = sign({ sub: "44444444-4444-4444-8444-444444444444", role: "Staff" });
const tracked = sign({ sid: "s1", u: "https://boreal.financial" });

async function app() {
  const router = (await import("../index.js")).default;
  const a = express();
  a.use(express.json());
  a.use("/api/client", router);
  return a;
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  queryMock.mockReset();
  queryMock.mockImplementation(answerBySql([
    [/SELECT COUNT\(\*\)::int AS n FROM applications WHERE id/, (_s: string, p?: unknown[]) => ({ rows: [{ n: p?.[0] === APP ? 1 : 0 }] })],
    [/app_phones/, (_s: string, p?: unknown[]) => ({ rows: [{ total: p?.[0] === APP ? 1 : 0, mine: p?.[1] === "5555550123" ? 1 : 0, known: 1 }] })],
  ]));
});

const GUARDED: Array<[string, string, Record<string, unknown>?]> = [
  ["get", `/api/client/application/${APP}/status`],
  ["patch", `/api/client/applications/${APP}`, { business: { name: "x" } }],
  ["get", `/api/client/messages?applicationId=${APP}`],
  ["get", `/api/client/application-stage?applicationId=${APP}`],
];

describe("client routes that name an application require its owner", () => {
  it.each(GUARDED)("%s %s: no token -> 401", async (method, path, body) => {
    const r = await (request(await app()) as any)[method](path).send(body ?? {});
    expect(r.status).toBe(401);
  });

  it.each(GUARDED)("%s %s: tracked-link token -> 401", async (method, path, body) => {
    const r = await (request(await app()) as any)[method](path).set("Authorization", `Bearer ${tracked}`).send(body ?? {});
    expect(r.status).toBe(401);
  });

  it.each(GUARDED)("%s %s: another client's token -> 403", async (method, path, body) => {
    const r = await (request(await app()) as any)[method](path).set("Authorization", `Bearer ${stranger}`).send(body ?? {});
    expect(r.status).toBe(403);
  });

  it.each(GUARDED)("%s %s: the owner gets past the guard", async (method, path, body) => {
    const r = await (request(await app()) as any)[method](path).set("Authorization", `Bearer ${owner}`).send(body ?? {});
    expect([401, 403]).not.toContain(r.status);
  });

  it.each(GUARDED)("%s %s: staff get past the guard", async (method, path, body) => {
    const r = await (request(await app()) as any)[method](path).set("Authorization", `Bearer ${staff}`).send(body ?? {});
    expect([401, 403]).not.toContain(r.status);
  });

  it("an id that is not an application (capability token) is left to the route", async () => {
    const r = await request(await app()).post(`/api/client/applications/${UNKNOWN}/submit`).send({});
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
  });

  it("pre-login endpoints without an application id stay public", async () => {
    const r = await request(await app()).get("/api/client/app-version");
    expect(r.status).toBe(200);
  });
});

describe("ownership rule", () => {
  it("an application with no linked phone yet is claimable by the signed-in client; a linked one is not", async () => {
    const { clientOwnershipOf } = await import("../../../auth/clientApplicationOwnership.js");
    queryMock.mockImplementation(answerBySql([[/app_phones/, { rows: [{ total: 1, mine: 0, known: 0 }] }]]));
    expect(await clientOwnershipOf(APP, OWNER_PHONE)).toBe("owner");
    queryMock.mockImplementation(answerBySql([[/app_phones/, { rows: [{ total: 1, mine: 0, known: 1 }] }]]));
    expect(await clientOwnershipOf(APP, OWNER_PHONE)).toBe("not_owner");
    queryMock.mockImplementation(answerBySql([[/app_phones/, { rows: [{ total: 0, mine: 0, known: 0 }] }]]));
    expect(await clientOwnershipOf(APP, OWNER_PHONE)).toBe("not_found");
  });
});
