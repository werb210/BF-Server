// BF_SERVER_v789_STAFF_USER_STATE - a staff token is only as good as the account
// behind it: missing, inactive, disabled, locked or stale-tv users get 401, the
// role comes from the database and token capabilities the role does not grant
// are dropped. Service tokens skip the lookup and verify with their sender's key.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-staff-user-v789";
const UID = "11111111-1111-4111-8111-111111111111";
const UID2 = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;
const { queryMock, users, logErrorMock, state } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  users: new Map<string, Record<string, unknown>>(),
  logErrorMock: vi.fn(),
  state: { failUsers: false },
}));

vi.mock("../db.js", () => {
  const pool = { query: queryMock, connect: vi.fn() };
  return { pool, db: pool, dbQuery: queryMock, query: queryMock, runQuery: queryMock, default: pool };
});

vi.mock("../observability/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: logErrorMock,
}));

vi.mock("../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));

function baseRow(id: string, over: Row = {}): Row {
  return {
    id, email: "s@example.com", role: "Staff", silo: "BF", silos: ["BF"],
    active: true, is_active: true, disabled: false, status: "ACTIVE",
    deleted_at: null, locked_until: null, token_version: 0, ...over,
  };
}

// Answers by SQL content only.
async function answer(sql: string, params: unknown[] = []) {
  if (/FROM users WHERE id = \$1/.test(sql)) {
    if (state.failUsers) throw new Error("relation users is unavailable");
    const row = users.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/from users u\s+where u\.id = \$1/i.test(sql)) {
    const row = users.get(String(params[0]));
    return { rows: row ? [{ ...row, tokenVersion: row.token_version }] : [], rowCount: row ? 1 : 0 };
  }
  if (/update users set token_version = token_version \+ 1 where id = \$1/i.test(sql)) {
    const row = users.get(String(params[0]));
    if (row) row.token_version = Number(row.token_version ?? 0) + 1;
    return { rows: [], rowCount: row ? 1 : 0 };
  }
  if (/update auth_refresh_tokens/i.test(sql)) return { rows: [], rowCount: 0 };
  if (/UPDATE users\s+SET/i.test(sql)) {
    return { rows: [{ id: params[params.length - 1], email: "s@example.com", role: "Staff", status: "INACTIVE" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const sign = (claims: Record<string, unknown>, secret = SECRET) =>
  jwt.sign(claims, secret, { algorithm: "HS256", expiresIn: "5m" });
const staffToken = (over: Record<string, unknown> = {}) => sign({ sub: UID, role: "Staff", tokenVersion: 0, tv: 0, ...over });
const usersQueries = () => queryMock.mock.calls.filter(([sql]) => /FROM users WHERE id = \$1/.test(String(sql))).length;

let app: express.Express;
let staffState: typeof import("../auth/staffUserState.js");

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  staffState = await import("../auth/staffUserState.js");
  const authMw = await import("../middleware/auth.js");
  const requireAuthMw = await import("../middleware/requireAuth.js");
  const authRoutes = (await import("../routes/auth.js")).default;
  app = express();
  app.use(express.json());
  app.get("/a", authMw.requireAuth, (req: any, res) => {
    res.json({ role: req.user?.role, capabilities: req.user?.capabilities, silo: req.user?.silo });
  });
  app.get("/b", requireAuthMw.requireAuth, (req: any, res) => {
    res.json({ role: req.user?.role, capabilities: req.user?.capabilities });
  });
  app.get("/admin-only", authMw.requireAuth, authMw.requireCapability("user:manage"), (_req, res) => { res.json({ ok: true }); });
  app.use("/api/auth", authRoutes);
});

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  delete process.env.AGENT_SERVICE_JWT_SECRET;
  delete process.env.BI_SERVICE_JWT_SECRET;
  staffState.resetStaffUserLoader();
  users.clear();
  users.set(UID, baseRow(UID));
  state.failUsers = false;
  logErrorMock.mockReset();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function both(token: string) {
  const a = await request(app).get("/a").set("Authorization", `Bearer ${token}`);
  const b = await request(app).get("/b").set("Authorization", `Bearer ${token}`);
  return [a, b] as const;
}

describe("staff user state (middleware/auth.ts and middleware/requireAuth.ts)", () => {
  it("an active user passes both middlewares", async () => {
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.silo).toBe("BF");
  });

  it("401 when the user row is missing", async () => {
    users.clear();
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
  });

  it("401 for a staff token whose subject is not a users id", async () => {
    const [a, b] = await both(staffToken({ sub: "test-user:+15875550100" }));
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
  });

  it.each([
    ["active false", { active: false }],
    ["is_active false", { is_active: false }],
    ["disabled", { disabled: true }],
    ["status INACTIVE", { status: "INACTIVE" }],
    ["deleted", { deleted_at: new Date().toISOString() }],
    ["locked", { locked_until: new Date(Date.now() + 60_000).toISOString() }],
  ])("401 when the user is %s", async (_name, over) => {
    users.set(UID, baseRow(UID, over));
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
  });

  it("an expired lock does not block", async () => {
    users.set(UID, baseRow(UID, { locked_until: new Date(Date.now() - 60_000).toISOString() }));
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });

  it("401 when tv is below users.token_version (a missing tv counts as 0)", async () => {
    users.set(UID, baseRow(UID, { token_version: 2 }));
    expect((await both(staffToken({ tv: 1 }))).map((r) => r.status)).toEqual([401, 401]);
    expect((await both(sign({ sub: UID, role: "Staff", tokenVersion: 2 }))).map((r) => r.status)).toEqual([401, 401]);
    expect((await both(staffToken({ tv: 2, tokenVersion: 2 }))).map((r) => r.status)).toEqual([200, 200]);
  });

  it("the role comes from the database, not the token", async () => {
    const [a, b] = await both(staffToken({ role: "Admin" }));
    expect(a.status).toBe(200);
    expect(a.body.role).toBe("Staff");
    expect(b.body.role).toBe("Staff");
    expect(a.body.capabilities).not.toContain("user:manage");
  });

  it("a database role that is not staff is refused", async () => {
    users.set(UID, baseRow(UID, { role: "Lender" }));
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(403);
    expect(b.status).toBe(403);
  });

  it("drops token capabilities the database role does not grant", async () => {
    const token = staffToken({ capabilities: ["user:manage", "crm:read", "ops:manage"] });
    const [a, b] = await both(token);
    expect(a.body.capabilities).toEqual(["crm:read"]);
    expect(b.body.capabilities).toEqual(["crm:read"]);
    const gated = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);
    expect(gated.status).toBe(403);
    users.set(UID, baseRow(UID, { role: "Admin" }));
    staffState.clearStaffUserCache(UID);
    const ok = await request(app).get("/admin-only").set("Authorization", `Bearer ${token}`);
    expect(ok.status).toBe(200);
  });

  it("a failed lookup is a logged 503, not a pass", async () => {
    state.failUsers = true;
    const [a, b] = await both(staffToken());
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(logErrorMock).toHaveBeenCalledWith("staff_user_lookup_failed", expect.objectContaining({ userId: UID }));
  });

  it("caches the row for 30 seconds", async () => {
    const t0 = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(t0);
    await request(app).get("/a").set("Authorization", `Bearer ${staffToken()}`);
    await request(app).get("/a").set("Authorization", `Bearer ${staffToken()}`);
    expect(usersQueries()).toBe(1);
    users.set(UID, baseRow(UID, { disabled: true }));
    now.mockReturnValue(t0 + 29_000);
    expect((await request(app).get("/a").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(200);
    expect(usersQueries()).toBe(1);
    now.mockReturnValue(t0 + 31_000);
    expect((await request(app).get("/a").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(401);
    expect(usersQueries()).toBe(2);
  });

  it("clearStaffUserCache makes the next request re-read the row", async () => {
    expect((await request(app).get("/b").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(200);
    users.set(UID, baseRow(UID, { disabled: true }));
    expect((await request(app).get("/b").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(200);
    staffState.clearStaffUserCache(UID);
    expect((await request(app).get("/b").set("Authorization", `Bearer ${staffToken()}`)).status).toBe(401);
  });

  it("service tokens skip the users lookup", async () => {
    const agent = sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" });
    const [a, b] = await both(agent);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(usersQueries()).toBe(0);
  });
});

describe("service tokens verify with the sender's key", () => {
  const agentClaims = { kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" };

  it("a JWT_SECRET-signed agent token is rejected when AGENT_SERVICE_JWT_SECRET is set", async () => {
    process.env.AGENT_SERVICE_JWT_SECRET = "agent-only-secret-v789";
    const [a, b] = await both(sign(agentClaims));
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    const legacy = sign({ id: "agent-service", role: "Staff" });
    expect((await both(legacy)).map((r) => r.status)).toEqual([401, 401]);
    const { verifyPrincipalToken } = await import("../auth/principal.js");
    expect(verifyPrincipalToken(sign(agentClaims))).toBeNull();
  });

  it("an agent token signed with AGENT_SERVICE_JWT_SECRET passes", async () => {
    process.env.AGENT_SERVICE_JWT_SECRET = "agent-only-secret-v789";
    const token = sign(agentClaims, "agent-only-secret-v789");
    const [a, b] = await both(token);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const { verifyPrincipalToken } = await import("../auth/principal.js");
    expect(verifyPrincipalToken(token)?.kind).toBe("service");
  });
});

describe("logout and logout-all", () => {
  it("POST /api/auth/logout answers 204", async () => {
    const res = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${staffToken()}`);
    expect(res.status).toBe(204);
  });

  it("POST /api/auth/logout-all bumps token_version, so earlier tokens stop working", async () => {
    const before = staffToken();
    expect((await request(app).get("/a").set("Authorization", `Bearer ${before}`)).status).toBe(200);
    const res = await request(app).post("/api/auth/logout-all").set("Authorization", `Bearer ${before}`);
    expect(res.status).toBe(204);
    expect(users.get(UID)?.token_version).toBe(1);
    expect((await request(app).get("/a").set("Authorization", `Bearer ${before}`)).status).toBe(401);
    expect((await request(app).get("/a").set("Authorization", `Bearer ${staffToken({ tv: 1 })}`)).status).toBe(200);
  });
});

describe("signers carry tv", () => {
  it("signAccessToken adds tv equal to tokenVersion", async () => {
    const { signAccessToken } = await import("../auth/jwt.js");
    const token = signAccessToken({ sub: UID, role: "Staff", tokenVersion: 3 });
    const claims = jwt.decode(token) as Record<string, unknown>;
    expect(claims.tv).toBe(3);
    expect(claims.tokenVersion).toBe(3);
  });
});

describe("admin user updates revoke tokens", () => {
  it("PATCH /api/users/:id with a role or status bumps token_version and clears the cache", async () => {
    users.set(UID2, baseRow(UID2));
    await staffState.loadStaffUser(UID2);
    const { adminUpdateUser } = await import("../services/users.service.js");
    const req: any = { params: { id: UID2 }, body: { role: "Staff", status: "INACTIVE" }, user: { userId: UID }, ip: "127.0.0.1", get: () => "ua" };
    const res: any = { locals: {}, status: vi.fn(() => res), json: vi.fn(() => res) };
    await adminUpdateUser(req, res);
    const update = queryMock.mock.calls.map(([sql]) => String(sql)).find((sql) => /UPDATE users\s+SET/i.test(sql));
    expect(update).toMatch(/token_version = token_version \+ CASE WHEN role IS DISTINCT FROM \$1 OR \$2 <> 'ACTIVE' THEN 1 ELSE 0 END/);
    expect(update).toMatch(/active = \(\$2 = 'ACTIVE'\)/);
    expect(update).toMatch(/disabled = \(\$2 <> 'ACTIVE'\)/);
    const before = usersQueries();
    await staffState.loadStaffUser(UID2);
    expect(usersQueries()).toBe(before + 1);
  });

  it("changeUserRole and setUserStatus clear the cache after commit", async () => {
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? [])), release: vi.fn() };
    const db = await import("../db.js");
    (db.pool.connect as any).mockResolvedValue(client);
    users.set(UID2, baseRow(UID2));
    const svc = await import("../modules/users/users.service.js");
    for (const run of [
      () => svc.changeUserRole({ userId: UID2, role: "Admin", actorId: UID }),
      () => svc.setUserStatus({ userId: UID2, active: false, actorId: UID }),
    ]) {
      await staffState.loadStaffUser(UID2);
      const before = usersQueries();
      await run();
      await staffState.loadStaffUser(UID2);
      expect(usersQueries()).toBeGreaterThan(before);
    }
  });
});
