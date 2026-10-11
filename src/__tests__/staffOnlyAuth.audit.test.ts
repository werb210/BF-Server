// BF_SERVER_STAFF_ONLY_AUTH_v1 - both auth middlewares used to accept ANY JWT
// signed with JWT_SECRET: client OTP tokens and SMS tracked-link tokens got 200
// on staff routes (/api/companies, /api/tasks, /api/calendar, /api/slf/deals),
// and requireAuth.ts defaulted a missing role to "Staff".
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql } from "./helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../db.js", async () => ({ ...(await vi.importActual<any>("../db.js")), pool: { query: queryMock } }));

const SECRET = "test-jwt-secret";
const STAFF_ID = "11111111-1111-4111-8111-111111111111";
const sign = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) => jwt.sign(claims, SECRET, { expiresIn: "5m", ...opts });

const TOKENS = {
  staff: sign({ sub: STAFF_ID, role: "Staff", tokenVersion: 0 }),
  admin: sign({ sub: STAFF_ID, role: "Admin", tokenVersion: 0 }),
  client: sign({ sub: "client:+15555550123", role: "client", phone: "+15555550123", tokenVersion: 0, isClient: true }),
  trackedLink: sign({ sid: "send-1", u: "https://boreal.financial/x" }),
  service: sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" }),
  serviceKindOnly: sign({ kind: "service", source: "maya-service" }),
  legacyAgent: sign({ id: "agent-service", role: "Staff" }),
  lender: sign({ sub: "lender:7", role: "Lender", lenderId: "7" }),
  referrer: sign({ sub: "referrer:9", role: "Referrer" }),
  accountant: sign({ sub: "accountant:5", role: "accountant", isAccountant: true }),
  applicant: sign({ kind: "applicant", phone: "+15555550123" }),
  // No role claim and a subject that is no users row.
  noRole: sign({ sub: "99999999-9999-4999-8999-999999999999" }),
  hs512: jwt.sign({ sub: STAFF_ID, role: "Staff" }, SECRET, { algorithm: "HS512" }),
};

describe("classifyPrincipal", () => {
  it("classifies every token kind BF-Server and BI-Server issue", async () => {
    const { classifyPrincipal } = await import("../auth/principal.js");
    const d = (t: string) => jwt.decode(t) as Record<string, unknown>;
    expect(classifyPrincipal(d(TOKENS.staff))).toBe("staff");
    expect(classifyPrincipal(d(TOKENS.client))).toBe("client");
    expect(classifyPrincipal(d(TOKENS.trackedLink))).toBe("unknown");
    expect(classifyPrincipal(d(TOKENS.service))).toBe("service");
    expect(classifyPrincipal(d(TOKENS.serviceKindOnly))).toBe("service");
    expect(classifyPrincipal(d(TOKENS.legacyAgent))).toBe("service");
    expect(classifyPrincipal(d(TOKENS.lender))).toBe("lender");
    expect(classifyPrincipal(d(TOKENS.referrer))).toBe("referrer");
    expect(classifyPrincipal(d(TOKENS.accountant))).toBe("accountant");
    expect(classifyPrincipal(d(TOKENS.applicant))).toBe("applicant");
    expect(classifyPrincipal(d(TOKENS.noRole))).toBe("unknown");
    // The users row wins over the role claim.
    expect(classifyPrincipal(d(TOKENS.staff), "Referrer")).toBe("referrer");
  });
});

async function appWith(kind: "auth" | "requireAuth") {
  const app = express();
  if (kind === "auth") {
    const { auth, requireAuthAllowing } = await import("../middleware/auth.js");
    app.get("/staff", auth, (_req, res) => res.json({ ok: true }));
    app.get("/client-ok", requireAuthAllowing("client"), (req: any, res) => res.json({ ok: true, kind: req.user?.principalKind }));
  } else {
    const { requireAuth, requireAuthAllowing } = await import("../middleware/requireAuth.js");
    app.get("/staff", requireAuth, (req: any, res) => res.json({ ok: true, role: req.user?.role }));
    app.get("/client-ok", requireAuthAllowing("client"), (req: any, res) => res.json({ ok: true, kind: req.user?.principalKind }));
  }
  return app;
}

describe.each(["auth", "requireAuth"] as const)("%s middleware is staff-only", (kind) => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    queryMock.mockReset();
    queryMock.mockImplementation(answerBySql([
      [/FROM users WHERE id = \$1/, (_sql: string, params?: unknown[]) => ({ rows: params?.[0] === STAFF_ID ? [{ id: STAFF_ID, email: "s@example.com", role: "Staff", silo: "BF", silos: ["BF"] }] : [] })],
    ]));
  });

  const get = async (path: string, token?: string) => {
    const r = request(await appWith(kind)).get(path);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  it("staff, service and legacy agent tokens pass", async () => {
    expect((await get("/staff", TOKENS.staff)).status).toBe(200);
    expect((await get("/staff", TOKENS.service)).status).toBe(200);
    expect((await get("/staff", TOKENS.serviceKindOnly)).status).toBe(200);
    expect((await get("/staff", TOKENS.legacyAgent)).status).toBe(200);
  });

  it("a client token is refused on a staff route", async () => {
    expect((await get("/staff", TOKENS.client)).status).toBe(403);
  });

  it("lender, referrer, accountant and applicant tokens are refused on a staff route", async () => {
    for (const t of [TOKENS.lender, TOKENS.referrer, TOKENS.accountant, TOKENS.applicant]) {
      expect((await get("/staff", t)).status).toBe(403);
    }
  });

  it("a tracked-link token is 401 everywhere, including client routes", async () => {
    expect((await get("/staff", TOKENS.trackedLink)).status).toBe(401);
    expect((await get("/client-ok", TOKENS.trackedLink)).status).toBe(401);
  });

  it("a token with no role (and no staff users row behind it) is not treated as Staff", async () => {
    expect((await get("/staff", TOKENS.noRole)).status).toBe(401);
  });

  it("only HS256 is accepted", async () => {
    expect((await get("/staff", TOKENS.hs512)).status).toBe(401);
  });

  it("a client token still works on a route that explicitly allows clients", async () => {
    const r = await get("/client-ok", TOKENS.client);
    expect(r.status).toBe(200);
    expect(r.body.kind).toBe("client");
    // ...and the allowance is for clients only.
    expect((await get("/client-ok", TOKENS.lender)).status).toBe(403);
    expect((await get("/client-ok", TOKENS.staff)).status).toBe(200);
  });

  it("no token is 401", async () => {
    expect((await get("/staff")).status).toBe(401);
  });
});

describe("staff routes that used to answer client tokens", () => {
  it("the routes the audit hit with a client token use the staff-only middleware", async () => {
    const fs = await import("node:fs");
    // companies / tasks / calendar / slf gate with the plain requireAuth from middleware/auth.ts.
    for (const f of ["src/routes/companies.ts", "src/routes/tasks.ts", "src/routes/calendar.ts", "src/routes/slf.ts"]) {
      const src = fs.readFileSync(f, "utf8");
      expect(src).toMatch(/from "\.\.\/middleware\/auth\.js"/);
      expect(src).not.toContain("requireAuthAllowing");
    }
  });
});
