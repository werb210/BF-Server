// BF_SERVER_CLIENT_ROUTE_GUARD_v1
// src/routes/client/index.ts carries a guard that stops a signed-in client
// reading an application that is not theirs. Routers mounted THERE inherit it.
// Routers mounted in routeRegistry.ts do not, and nothing says so at the point
// of mounting. Two routes were mounted that way and both leaked: /client/voice
// minted a spoofable Twilio identity from a query parameter, and
// /client/documents-needed returned any application's document checklist.
//
// This test fails when a /client/* router mounted outside the guard answers a
// client about an application that is not theirs, unless it is listed below
// with a reason. Every route of every such router is called, as someone else.
import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { answerBySql, callsMatching } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async (orig) => ({ ...(await orig() as any), pool: { query: queryMock, connect: vi.fn() }, runQuery: queryMock, dbQuery: queryMock }));
import { API_ROUTE_MOUNTS } from "../routes/routeRegistry.js";
import { callerOwnsApplication } from "../auth/clientApplicationOwnership.js";

// Routers that legitimately need no ownership check. Adding an entry here is a
// deliberate act and must carry a reason.
const EXEMPT: Record<string, string> = {
  "/client":
    "This IS the guarded router (src/routes/client/index.ts). The guard lives inside it.",
  "/client/issues":
    "Write-only bug report. applicationId is optional metadata, nothing is read back.",
};

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MY_PHONE = "+14038721234";
const clientToken = (phone: string | null) =>
  jwt.sign({ sub: "client:" + (phone ?? "x"), role: "client", ...(phone ? { phone } : {}) }, process.env.JWT_SECRET as string);
const OWNERSHIP_SQL = /WITH app_phones AS/;

function ownedBy(owner: boolean) {
  queryMock.mockImplementation(answerBySql([[OWNERSHIP_SQL, { rows: [{ n: owner ? "1" : "0" }] }]]));
}

type RouteDef = { method: "get" | "post" | "put" | "patch" | "delete"; path: string };
function routesOf(router: Router): RouteDef[] {
  const out: RouteDef[] = [];
  for (const layer of (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) out.push({ method: m as RouteDef["method"], path: String(layer.route.path) });
  }
  return out;
}

function call(app: express.Express, mount: string, r: RouteDef, token: string | null) {
  const p = r.path.replace(/:[A-Za-z_]+/g, APP_ID);
  const req = request(app)[r.method](`/api${mount}${p}?applicationId=${APP_ID}`);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return r.method === "get" || r.method === "delete" ? req : req.send({ applicationId: APP_ID });
}

const mounts = API_ROUTE_MOUNTS.filter((m) => m.path.startsWith("/client"));
const guarded = mounts.filter((m) => !EXEMPT[m.path]);
const app = express();
app.use(express.json());
for (const m of guarded) app.use(`/api${m.path}`, m.router);

beforeEach(() => { queryMock.mockReset(); ownedBy(false); });

describe("BF_SERVER_CLIENT_ROUTE_GUARD_v1", () => {
  it("finds the client routers mounted outside the guarded router", () => {
    // If this drops the test would pass vacuously.
    expect(mounts.length).toBeGreaterThan(2);
    expect(guarded.length).toBeGreaterThan(0);
    for (const m of guarded) expect(routesOf(m.router).length, m.path).toBeGreaterThan(0);
  });

  it("every exemption carries a reason", () => {
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(20);
  });

  describe.each(guarded.map((m) => ({ path: m.path, router: m.router })))("$path", ({ path, router }) => {
    it.each(routesOf(router))(`$method $path refuses a client asking about someone else's application, after checking ownership`, async (r) => {
      ownedBy(false);
      const res = await call(app, path, r, clientToken(MY_PHONE));
      expect([401, 403], `${path}${r.path} answered ${res.status} for a non-owner. It is mounted in routeRegistry.ts, so it does NOT inherit ` +
        `the guard in src/routes/client/index.ts. Call callerOwnsApplication() from src/auth/clientApplicationOwnership.ts, ` +
        `mount it inside client/index.ts, or add it to EXEMPT in this test with a reason.`).toContain(res.status);
      expect(callsMatching(queryMock, OWNERSHIP_SQL).length, `${path}${r.path} must refuse by checking ownership`).toBeGreaterThan(0);
    });

    it.each(routesOf(router))("$method $path fails closed: no token, and a failed ownership query, both refuse", async (r) => {
      const anon = await call(app, path, r, null);
      expect([401, 403]).toContain(anon.status);
      queryMock.mockImplementation(answerBySql([[OWNERSHIP_SQL, new Error("db down")]]));
      const broken = await call(app, path, r, clientToken(MY_PHONE));
      expect([401, 403]).toContain(broken.status);
    });

    it.each(routesOf(router))("$method $path lets the owner through", async (r) => {
      ownedBy(true);
      const res = await call(app, path, r, clientToken(MY_PHONE));
      expect([401, 403]).not.toContain(res.status);
    });
  });

  describe("the shared predicate covers partners and guarantors, not just the applicant", () => {
    const req = (token: string | null) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as any;

    it("checks application_contacts UNION the applicant contact, by last 10 digits", async () => {
      ownedBy(true);
      expect(await callerOwnsApplication(req(clientToken(MY_PHONE)), APP_ID)).toBe(true);
      const [sql, params] = callsMatching(queryMock, OWNERSHIP_SQL)[0] as [string, unknown[]];
      // A joint file's partner has a different phone from applications.contact_id.
      // Losing the UNION would 403 every partner on every application.
      expect(sql).toContain("FROM application_contacts ac");
      expect(sql).toContain("UNION");
      expect(sql).toContain("FROM applications a");
      expect(params).toEqual([APP_ID, "4038721234"]);
    });

    it("no token, bad token, no phone, someone else's application, or a failed query all deny", async () => {
      ownedBy(true);
      expect(await callerOwnsApplication(req(null), APP_ID)).toBe(false);
      expect(await callerOwnsApplication(req(jwt.sign({ phone: MY_PHONE }, "wrong-secret")), APP_ID)).toBe(false);
      expect(await callerOwnsApplication(req(clientToken(null)), APP_ID)).toBe(false);
      ownedBy(false);
      expect(await callerOwnsApplication(req(clientToken(MY_PHONE)), APP_ID)).toBe(false);
      queryMock.mockImplementation(answerBySql([[OWNERSHIP_SQL, new Error("db down")]]));
      const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await callerOwnsApplication(req(clientToken(MY_PHONE)), APP_ID)).toBe(false);
      err.mockRestore();
    });
  });
});
