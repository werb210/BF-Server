// BF_SERVER_v784_MAYA_IDENTITY - the staff lookup lives in services/mayaContext.ts and is
// sent as a signed X-Maya-Context; it is no longer injected into the body.
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { callsMatching, sqlText } from "./helpers/answerBySql.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-min-10-chars";
const SECRET = process.env.JWT_SECRET as string;
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => {
  const real: any = await orig();
  return { ...real, pool: { query: queryMock }, runQuery: queryMock };
});
vi.mock("../modules/ai/chat.repo.js", () => ({ addMessage: async () => undefined }));

import mayaRoutes from "../routes/maya.js";
import { deriveMayaIdentity } from "../services/mayaContext.js";

const app = express(); app.use(express.json()); app.use("/api/maya", mayaRoutes);
const staffJwt = jwt.sign({ id: STAFF_ID, sub: STAFF_ID, role: "Staff" }, SECRET, { algorithm: "HS256" });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.MAYA_URL = "http://maya.test";
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "hi" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    if (/FROM users WHERE id::text = \$1/.test(sqlText(sql)) && params?.[0] === STAFF_ID) {
      return { rows: [{ first_name: "Sam", last_name: "Staff", email: "sam@boreal.test", role: "Staff", silo: "BF", silos: ["BF"] }] };
    }
    return { rows: [], rowCount: 0 };
  });
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.MAYA_URL; });

describe("Maya staff identity forwarding", () => {
  it("resolves the staff token subject and forwards a staff identity", async () => {
    const r = await request(app).post("/api/maya/chat").set("Authorization", `Bearer ${staffJwt}`).send({ message: "pipeline?", staff: { id: "someone-else", role: "Admin" } });
    expect(r.status).toBe(200);
    const [lookup] = callsMatching(queryMock, /FROM users WHERE id::text = \$1/);
    expect(lookup![1]).toEqual([STAFF_ID]);
    const [, init] = fetchMock.mock.calls.at(-1) as unknown as [string, any];
    const ctx = jwt.verify(init.headers["X-Maya-Context"], SECRET, { algorithms: ["HS256"] }) as any;
    expect(ctx).toMatchObject({ audience: "staff", staff: { id: STAFF_ID, name: "Sam Staff", email: "sam@boreal.test", role: "Staff" }, silo: "BF" });
    expect(JSON.parse(init.body)).toEqual({ message: "pipeline?" });
  });

  it("deriveMayaIdentity returns the loaded staff, and a token for no user is public", async () => {
    expect(await deriveMayaIdentity({ headers: { authorization: `Bearer ${staffJwt}` } })).toEqual({
      audience: "staff", staff: { id: STAFF_ID, name: "Sam Staff", email: "sam@boreal.test", role: "Staff" }, silo: "BF",
    });
    const ghost = jwt.sign({ id: "22222222-2222-4222-8222-222222222222", sub: "22222222-2222-4222-8222-222222222222", role: "Staff" }, SECRET, { algorithm: "HS256" });
    expect((await deriveMayaIdentity({ headers: { authorization: `Bearer ${ghost}` } })).audience).toBe("public");
  });
});
