// BF_SERVER_v870_CRM_DATA_MODEL - the permission matrix, the built-in templates, server-side enforcement in both staff
// auth middlewares, and record visibility for custom roles (ported from KS-server #49, no plan gate).
//
// The core promise: people on a built-in role keep exactly the access they had. Proven three ways here:
//   1. the auth middlewares run no role query and refuse nothing for someone with no custom role;
//   2. each built-in template grants every permission any route already open to that role needs (checked against the
//      whole route registry), so a custom role copied from a template unchanged also loses nothing;
//   3. record visibility for built-in roles still comes from role_record_visibility, with the same SQL.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-custom-roles";
const UID = "11111111-1111-4111-8111-111111111111";
const ROLE_ID = "33333333-3333-4333-8333-333333333333";

const { queryMock, users, roles, state } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  users: new Map<string, Record<string, unknown>>(),
  roles: new Map<string, Record<string, unknown>>(),
  state: { failRoles: false },
}));

vi.mock("../../db.js", () => {
  const pool = { query: queryMock, connect: vi.fn() };
  return { pool, db: pool, dbQuery: queryMock, query: queryMock, runQuery: queryMock, default: pool };
});
vi.mock("../../observability/logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn(async () => undefined) }));

// Answers by SQL content only.
async function answer(sql: string, params: unknown[] = []) {
  if (/FROM users WHERE id = \$1 LIMIT 1/.test(sql)) {
    const row = users.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/FROM custom_roles WHERE id = \$1/.test(sql)) {
    if (state.failRoles) throw Object.assign(new Error("connection reset"), { code: "08006" });
    const row = roles.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

const sign = (claims: Record<string, unknown>) => jwt.sign(claims, SECRET, { algorithm: "HS256", expiresIn: "5m" });
const token = (role = "Staff") => `Bearer ${sign({ sub: UID, id: UID, role, tokenVersion: 0, tv: 0 })}`;
const roleQueries = () => queryMock.mock.calls.filter(([sql]) => /custom_roles/.test(String(sql))).length;

function userRow(role: string, customRoleId: string | null = null) {
  return {
    id: UID, email: "s@example.com", role, silo: "BF", silos: ["BF"], active: true, is_active: true, disabled: false,
    status: "ACTIVE", deleted_at: null, locked_until: null, token_version: 0, custom_role_id: customRoleId,
  };
}

let app: express.Express;
let perms: typeof import("../permissions.js");
let staffState: typeof import("../../auth/staffUserState.js");
let customRoles: typeof import("../customRoles.js");

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  perms = await import("../permissions.js");
  staffState = await import("../../auth/staffUserState.js");
  customRoles = await import("../customRoles.js");
  const authMw = await import("../../middleware/auth.js");
  const requireAuthMw = await import("../../middleware/requireAuth.js");
  app = express();
  app.use(express.json());
  // Both staff middlewares, on representative paths.
  app.all(/^\/api\/.*/, (req, res, next) => (req.headers["x-mw"] === "b" ? requireAuthMw.requireAuth(req, res, next) : authMw.requireAuth(req, res, next)), (req: any, res) => {
    res.json({ ok: true, role: req.user?.role, custom_role_id: req.user?.custom_role_id ?? null });
  });
});

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
  staffState.resetStaffUserLoader();
  customRoles.clearCustomRoleCache();
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => answer(String(sql), params ?? []));
  users.clear();
  roles.clear();
  state.failRoles = false;
});

afterEach(() => { staffState.resetStaffUserLoader(); });

// Representative requests across every area, plus personal endpoints.
const SAMPLE: Array<[string, string]> = [
  ["GET", "/api/crm/contacts"], ["POST", "/api/crm/contacts"], ["PATCH", "/api/crm/contacts/abc"], ["DELETE", "/api/crm/contacts/abc"],
  ["GET", "/api/companies"], ["GET", "/api/portal/applications"], ["POST", "/api/applications"], ["GET", "/api/pipeline"],
  ["GET", "/api/documents/x/documents"], ["GET", "/api/portal/lenders"], ["GET", "/api/communications"], ["POST", "/api/o365/mail/send"],
  ["GET", "/api/calls"], ["GET", "/api/marketing/campaigns"], ["GET", "/api/reports/summary"], ["GET", "/api/reporting/x.csv"],
  ["PUT", "/api/settings/maya-config"], ["POST", "/api/settings/maya-tts"], ["PUT", "/api/reports/layouts"], ["GET", "/api/users"],
  ["POST", "/api/quickbooks/applications/a1/retry"], ["POST", "/api/quickbooks/connect"], ["POST", "/api/pipelines/move"],
  ["GET", "/api/users/me"], ["GET", "/api/dashboard"], ["GET", "/api/calendar"], ["GET", "/api/teams/me"], ["GET", "/api/roles/me"],
];

describe("the permission matrix", () => {
  it("maps a request to an area and an action", () => {
    const r = perms.requiredPermission;
    expect(r("GET", "/crm/contacts")).toEqual({ area: "contacts", action: "view" });
    expect(r("POST", "/crm/contacts")).toEqual({ area: "contacts", action: "create" });
    expect(r("POST", "/crm/contacts/search")).toEqual({ area: "contacts", action: "view" });
    expect(r("POST", "/crm/contacts/bulk-delete")).toEqual({ area: "contacts", action: "delete" });
    expect(r("POST", "/crm/contacts/merge")).toEqual({ area: "contacts", action: "edit" });
    expect(r("PATCH", "/crm/companies/1")).toEqual({ area: "companies", action: "edit" });
    expect(r("DELETE", "/portal/applications/1")).toEqual({ area: "applications", action: "delete" });
    expect(r("GET", "/credit-summary-v2/1/export.pdf")).toEqual({ area: "applications", action: "export" });
    expect(r("GET", "/portal/documents/1")).toEqual({ area: "documents", action: "view" });
    expect(r("GET", "/portal/lender-products")).toEqual({ area: "lenders", action: "view" });
    expect(r("POST", "/quickbooks/applications/a1/retry")).toEqual({ area: "applications", action: "create" });
    expect(r("POST", "/quickbooks/connect")).toEqual({ area: "billing", action: "edit" });
    expect(r("POST", "/pipelines/move")).toEqual({ area: "applications", action: "edit" });
    expect(r("POST", "/o365/mail/send")).toEqual({ area: "communications", action: "create" });
    expect(r("GET", "/crm/inbox/m1")).toEqual({ area: "communications", action: "view" });
    expect(r("GET", "/calls/recordings/1")).toEqual({ area: "calls", action: "view" });
    expect(r("POST", "/marketing/google-ads/icp/export")).toEqual({ area: "marketing", action: "export" });
    expect(r("GET", "/reports/pipeline")).toEqual({ area: "reports", action: "view" });
    expect(r("PATCH", "/users/1")).toEqual({ area: "users", action: "edit" });
    expect(r("PUT", "/teams/1/members")).toEqual({ area: "users", action: "edit" });
    expect(r("PUT", "/never-log")).toEqual({ area: "settings", action: "edit" });
    expect(r("GET", "/export/full")).toEqual({ area: "settings", action: "export" });
    expect(r("PUT", "/custom-fields/contact/records/1")).toEqual({ area: "contacts", action: "edit" });
  });

  it("leaves personal and app-shell endpoints to everyone", () => {
    for (const [m, p] of [
      ["GET", "/users/me"], ["PATCH", "/users/me"], ["GET", "/roles/me"], ["GET", "/settings/me"], ["GET", "/settings"],
      ["GET", "/teams/me"], ["GET", "/security/me/sessions"], ["GET", "/custom-fields/contact"], ["PUT", "/task-defaults/me"],
      ["GET", "/dashboard"], ["GET", "/calendar/events"], ["GET", "/tasks"], ["GET", "/notifications"], ["PUT", "/lead-rotation/me"],
    ]) expect(perms.requiredPermission(m, p)).toBeNull();
  });

  it("normalizes input and never lets a custom role exceed its base", () => {
    const p = perms.normalizePermissions({ contacts: { edit: true, bogus: true }, nope: { view: true }, users: ["view", "delete"] });
    expect(p.contacts).toEqual({ view: true, create: false, edit: true, delete: false, export: false }); // edit implies view
    expect(p.users).toEqual({ view: true, create: false, edit: false, delete: true, export: false });
    expect(perms.beyondBase(p, "Staff")).toEqual(["users.view", "users.delete"]);
    const clamped = perms.clampToBase(p, "Staff");
    expect(clamped.users.view).toBe(false);
    expect(clamped.contacts.edit).toBe(true);
    expect(perms.beyondBase(perms.fullPermissions(), "Admin")).toEqual([]);
  });

  it("the Admin and Ops templates are every permission; Staff and Marketing are the same; only Admin and Ops manage users", () => {
    expect(perms.permissionList(perms.templateFor("Admin"))).toHaveLength(perms.AREAS.length * perms.ACTIONS.length);
    expect(perms.templateFor("Ops")).toEqual(perms.templateFor("Admin"));
    expect(perms.templateFor("Marketing")).toEqual(perms.templateFor("Staff"));
    expect(perms.templateFor("Staff").users.view).toBe(false);
    // What Staff already does outside the CRM: their report layouts, Maya's voice, a client's fee invoice retry.
    expect(perms.allows(perms.templateFor("Staff"), "reports", "edit")).toBe(true);
    expect(perms.allows(perms.templateFor("Staff"), "settings", "edit")).toBe(true);
    expect(perms.allows(perms.templateFor("Staff"), "billing", "edit")).toBe(true);
  });

  it("each built-in template grants every permission the routes already open to that role need", async () => {
    const { ROUTES } = await import("../../routes/routeRegistry.js");
    const missing: string[] = [];
    let checked = 0;
    for (const route of ROUTES) {
      const need = perms.requiredPermission(route.method, route.path.replace(/^\/api/, ""));
      if (!need) continue;
      for (const role of route.roles) {
        if (!perms.isBaseRole(role)) continue;
        checked++;
        if (!perms.allows(perms.templateFor(role), need.area, need.action)) missing.push(`${role} ${route.method} ${route.path} -> ${need.area}.${need.action}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  }, 120_000); // importing the whole route registry is slow on a loaded machine
});

describe("existing users keep exactly what they have", () => {
  for (const role of ["Admin", "Ops", "Staff", "Marketing"]) {
    it(`${role} with no custom role: every request passes and no role query runs (both middlewares)`, async () => {
      users.set(UID, userRow(role));
      for (const mw of ["a", "b"]) {
        for (const [method, path] of SAMPLE) {
          const res = await (request(app) as any)[method.toLowerCase()](path).set("Authorization", token(role)).set("x-mw", mw).send({ role: "Admin" });
          expect(res.status, `${mw} ${method} ${path}`).toBe(200);
          expect(res.body.custom_role_id).toBeNull();
        }
      }
      expect(roleQueries()).toBe(0);
    });
  }

  it("a custom role id in the token is ignored: it only ever comes from the users row", async () => {
    users.set(UID, userRow("Staff"));
    const forged = `Bearer ${sign({ sub: UID, id: UID, role: "Staff", tokenVersion: 0, tv: 0, custom_role_id: ROLE_ID })}`;
    const res = await request(app).get("/api/crm/contacts").set("Authorization", forged);
    expect(res.status).toBe(200);
    expect(res.body.custom_role_id).toBeNull();
    expect(roleQueries()).toBe(0);
  });

  it("a custom role copied from a template unchanged allows the same sample requests as its base", async () => {
    for (const base of ["Staff", "Ops", "Marketing", "Admin"] as const) {
      customRoles.clearCustomRoleCache();
      staffState.resetStaffUserLoader();
      roles.set(ROLE_ID, { id: ROLE_ID, name: `Copy of ${base}`, base_role: base, permissions: perms.templateFor(base), record_visibility: "all", archived_at: null });
      users.set(UID, userRow(base, ROLE_ID));
      for (const [method, path] of SAMPLE) {
        const need = perms.requiredPermission(method, path.replace(/^\/api/, ""));
        const allowedByTemplate = !need || perms.allows(perms.templateFor(base), need.area, need.action);
        const res = await (request(app) as any)[method.toLowerCase()](path).set("Authorization", token(base));
        expect(res.status, `${base} ${method} ${path}`).toBe(allowedByTemplate ? 200 : 403);
      }
    }
  });
});

describe("a custom role is enforced on the server", () => {
  const viewer = () => {
    const p = perms.emptyPermissions();
    p.contacts.view = true;
    p.companies.view = true;
    p.applications.view = true;
    return p;
  };

  beforeEach(() => {
    roles.set(ROLE_ID, { id: ROLE_ID, name: "Read only", base_role: "Staff", permissions: viewer(), record_visibility: "own", archived_at: null });
    users.set(UID, userRow("Staff", ROLE_ID));
  });

  it("allows what the matrix grants and refuses the rest in plain words (both middlewares)", async () => {
    for (const mw of ["a", "b"]) {
      expect((await request(app).get("/api/crm/contacts").set("Authorization", token()).set("x-mw", mw)).status).toBe(200);
      expect((await request(app).get("/api/dashboard").set("Authorization", token()).set("x-mw", mw)).status).toBe(200);
      const del = await request(app).delete("/api/crm/contacts/1").set("Authorization", token()).set("x-mw", mw);
      expect(del.status).toBe(403);
      expect(del.body).toMatchObject({ error: "permission_denied", area: "contacts", action: "delete" });
      expect(del.body.message).toMatch(/does not let you delete contacts/);
      expect((await request(app).get("/api/marketing/x").set("Authorization", token()).set("x-mw", mw)).status).toBe(403);
      expect((await request(app).get("/api/reports/x").set("Authorization", token()).set("x-mw", mw)).status).toBe(403);
      expect((await request(app).post("/api/crm/contacts").set("Authorization", token()).set("x-mw", mw)).status).toBe(403);
    }
  });

  it("the role is cached briefly, and a change shows after the cache is cleared", async () => {
    await request(app).get("/api/crm/contacts").set("Authorization", token());
    await request(app).get("/api/companies").set("Authorization", token());
    expect(roleQueries()).toBe(1);
    const p = viewer();
    p.contacts.delete = true;
    roles.set(ROLE_ID, { ...roles.get(ROLE_ID)!, permissions: p });
    customRoles.clearCustomRoleCache();
    expect((await request(app).delete("/api/crm/contacts/1").set("Authorization", token())).status).toBe(200);
  });

  it("a custom role built from Admin cannot change roles or create roles", async () => {
    roles.set(ROLE_ID, { id: ROLE_ID, name: "Office manager", base_role: "Admin", permissions: { ...perms.fullPermissions(), billing: perms.emptyPermissions().billing }, record_visibility: "all", archived_at: null });
    users.set(UID, userRow("Admin", ROLE_ID));
    expect((await request(app).patch("/api/users/x").set("Authorization", token("Admin")).send({ first_name: "Pat" })).status).toBe(200);
    for (const [method, path, body] of [
      ["patch", "/api/users/x", { role: "Admin" }], ["patch", "/api/users/x", { custom_role_id: ROLE_ID }], ["post", "/api/users", { role: "Admin" }],
      ["post", "/api/users/x/role", { role: "Staff" }], ["post", "/api/roles", { name: "x" }], ["patch", "/api/roles/1", {}],
    ] as const) {
      const res = await (request(app) as any)[method](path).set("Authorization", token("Admin")).send(body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toBe("full_admin_required");
    }
    expect((await request(app).post("/api/quickbooks/connect").set("Authorization", token("Admin"))).status).toBe(403); // no billing
    expect((await request(app).get("/api/roles/me").set("Authorization", token("Admin"))).status).toBe(200);
  });

  it("fails closed when the role cannot be read", async () => {
    state.failRoles = true;
    const res = await request(app).get("/api/crm/contacts").set("Authorization", token());
    expect(res.status).toBe(503);
  });

  it("a role id that names no role grants nothing in any area", async () => {
    roles.clear();
    expect((await request(app).get("/api/crm/contacts").set("Authorization", token())).status).toBe(403);
    expect((await request(app).get("/api/users/me").set("Authorization", token())).status).toBe(200);
  });

  it("service tokens are never checked against a role", async () => {
    const svc = `Bearer ${sign({ kind: "service", service: "agent", source: "agent", principal: "service", id: "agent-service", role: "Staff" })}`;
    expect((await request(app).delete("/api/crm/contacts/1").set("Authorization", svc)).status).toBe(200);
    expect(roleQueries()).toBe(0);
  });
});

describe("record visibility for custom roles", () => {
  const fakeDb = (o: { userVis?: string | null; customVis?: string | null; roleVis?: string | null }) => {
    const sqls: string[] = [];
    return {
      sqls,
      query: async (sql: string) => {
        sqls.push(sql);
              if (/SELECT record_visibility FROM custom_roles/.test(sql)) return { rows: [{ record_visibility: o.userVis ?? null, role_visibility: o.customVis ?? null, found: true }] };
        if (/SELECT visibility FROM role_record_visibility/.test(sql)) return { rows: [{ record_visibility: o.userVis ?? null, role_visibility: o.roleVis ?? null, found: true }] };
        if (/FROM sales_team_members m1/.test(sql)) return { rows: [] };
        return { rows: [] };
      },
    };
  };

  it("built-in roles keep the per-role setting (same query as before); custom roles use their own", async () => {
    const { resolveScope, clearVisibilityCache } = await import("../../visibility/scope.js");
    clearVisibilityCache();
    const builtIn = fakeDb({ roleVis: "team", customVis: "own" });
    expect((await resolveScope(builtIn as any, UID, "Staff")).visibility).toBe("team");
    expect(builtIn.sqls.some((s) => /custom_roles/.test(s))).toBe(false);
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ roleVis: "team", customVis: "own" }) as any, UID, "Staff", ROLE_ID)).visibility).toBe("own");
    clearVisibilityCache();
    // A per-person override still wins over the role.
    expect((await resolveScope(fakeDb({ userVis: "all", customVis: "own" }) as any, UID, "Staff", ROLE_ID)).visibility).toBe("all");
    clearVisibilityCache();
    // Built-in Admins always see everything; an Admin-based custom role follows its own setting.
    expect((await resolveScope(fakeDb({}) as any, UID, "Admin")).mode).toBe("all");
    expect((await resolveScope(fakeDb({ customVis: "team" }) as any, UID, "Admin", ROLE_ID)).visibility).toBe("team");
    clearVisibilityCache();
  });
});

describe("assigning a custom role", () => {
  it("puts the person on the role's base role, so every existing role check sees the base", async () => {
    roles.set(ROLE_ID, { id: ROLE_ID, name: "Campaigns", base_role: "Marketing", archived_at: null });
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/SELECT id::text AS id, name, base_role, archived_at FROM custom_roles WHERE id = \$1/.test(sql)) {
        const r = roles.get(String(params?.[0]));
        return { rows: r ? [r] : [] };
      }
      return answer(String(sql), params ?? []);
    });
    const { resolveRoleAssignment } = await import("../../services/users.service.js");
    expect(await resolveRoleAssignment(undefined, ROLE_ID)).toEqual({ role: "Marketing", customRoleId: ROLE_ID, customRoleName: "Campaigns" });
    expect(await resolveRoleAssignment("Staff", undefined)).toEqual({ role: "Staff", customRoleId: null });
    expect(await resolveRoleAssignment(undefined, null)).toEqual({ customRoleId: null });
    expect(await resolveRoleAssignment(undefined, undefined)).toEqual({});
    roles.set(ROLE_ID, { ...roles.get(ROLE_ID)!, archived_at: new Date().toISOString() });
    await expect(resolveRoleAssignment(undefined, ROLE_ID)).rejects.toMatchObject({ status: 409 });
  });
});
