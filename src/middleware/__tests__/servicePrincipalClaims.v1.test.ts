// BF_SERVER_SERVICE_PRINCIPAL_v1
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { answerBySql } from "../../__tests__/helpers/answerBySql.js";
import { STAFF_USER_ID, staffToken } from "../../__tests__/helpers/staffToken.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../db.js")>()),
  pool: { query: queryMock },
  runQuery: queryMock,
  dbQuery: queryMock,
}));

queryMock.mockImplementation(
  answerBySql([[/FROM users WHERE id = \$1/, { rows: [{ id: STAFF_USER_ID, email: "staff@boreal.test", role: "Staff", silo: "BF", silos: ["BF"] }] }]]),
);

async function whoAmI(token: string) {
  const { requireAuth } = await import("../auth.js");
  const app = express();
  app.get("/me", requireAuth, (req: any, res) => {
    const u = req.user;
    res.json({ isServicePrincipal: u.isServicePrincipal, serviceName: u.serviceName, actorResolved: u.actorResolved });
  });
  return request(app).get("/me").set("Authorization", `Bearer ${token}`);
}

describe("auth middleware surfaces the service principal", () => {
  it("reads the principal claim", async () => {
    const token = jwt.sign({ id: "agent-service", role: "Staff", principal: "service", service: "maya" }, String(process.env.JWT_SECRET));
    const res = await whoAmI(token);
    expect(res.status).toBe(200);
    expect(res.body.isServicePrincipal).toBe(true);
    expect(res.body.serviceName).toBe("maya");
  });

  it("exposes the flags downstream writers need", async () => {
    // A service id resolves to no users row: expected, not corruption.
    const service = await whoAmI(jwt.sign({ id: "agent-service", role: "Staff", principal: "service" }, String(process.env.JWT_SECRET)));
    expect(service.body).toEqual({ isServicePrincipal: true, serviceName: "unknown", actorResolved: false });
    // A human token: unchanged, and the actor resolves to the users row.
    const human = await whoAmI(staffToken("Staff"));
    expect(human.status).toBe(200);
    expect(human.body).toEqual({ isServicePrincipal: false, serviceName: null, actorResolved: true });
  });

  it("still pins the verification algorithm", async () => {
    // BF_SERVER_JWT_HARDENING_v1 must survive this change.
    const claims = { sub: STAFF_USER_ID, role: "Admin", tokenVersion: 0, tv: 0 };
    expect((await whoAmI(jwt.sign(claims, String(process.env.JWT_SECRET), { algorithm: "HS384" }))).status).toBe(401);
    expect((await whoAmI(jwt.sign(claims, String(process.env.JWT_SECRET), { algorithm: "HS512" }))).status).toBe(401);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect((await whoAmI(unsigned)).status).toBe(401);
    expect((await whoAmI(jwt.sign(claims, String(process.env.JWT_SECRET), { algorithm: "HS256" }))).status).toBe(200);
  });
});
