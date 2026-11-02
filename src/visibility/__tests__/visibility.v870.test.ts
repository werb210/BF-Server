// BF_SERVER_v870_CRM_DATA_MODEL - who sees which records: resolution (role, per-person override, team, Admin, custom
// role), the SQL, the record guard and the activity views (ported from KS-server #39 / #46, no plan gate).
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  ALL_SCOPE, canSeeRecord, clearVisibilityCache, narrowToOwners, ownerFilterSql, resolveRoleOnlyScope, resolveScope, resolveUnverifiedActorScope,
  scopeForActingUser,
} from "../scope.js";
import { recordGuard, CRM_RULES, APPLICATIONS_RULES } from "../recordGuard.js";
import { viewSql } from "../scopedDb.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

type Opts = { userVis?: string | null; roleVis?: string | null; customVis?: string | null; team?: string[]; visible?: string[]; roleFor?: string; anyRestriction?: boolean };
function fakeDb(o: Opts = {}) {
  const sqls: string[] = [];
  return {
    sqls,
    query: async (sql: string, params: unknown[] = []) => {
      sqls.push(sql);
      if (/record_visibility, \(SELECT visibility FROM role_record_visibility/.test(sql)) return { rows: [{ record_visibility: o.userVis ?? null, role_visibility: o.roleVis ?? null, found: true }] };
      if (/record_visibility, \(SELECT record_visibility FROM custom_roles/.test(sql)) return { rows: [{ record_visibility: o.userVis ?? null, role_visibility: o.customVis ?? null, found: true }] };
      if (/EXISTS \(SELECT 1 FROM role_record_visibility WHERE visibility IN/.test(sql)) return { rows: [{ x: o.anyRestriction === true }] };
      if (/FROM role_record_visibility WHERE role/.test(sql)) return { rows: o.roleVis ? [{ visibility: o.roleVis }] : [] };
      if (/record_visibility IN \('team', 'own'\)/.test(sql)) return { rows: [{ x: false }] };
      if (/FROM sales_team_members m1/.test(sql)) return { rows: (o.team ?? []).map((id) => ({ id })) };
      if (/SELECT role, custom_role_id::text AS custom_role_id FROM users WHERE id/.test(sql)) return { rows: o.roleFor ? [{ role: o.roleFor, custom_role_id: null }] : [] };
      if (/SELECT 1 FROM (contacts|companies|applications) r WHERE r.id/.test(sql)) {
        const owners = params[1] as string[];
        return { rows: (o.visible ?? []).includes(String(params[0])) && owners.length ? [{ "?column?": 1 }] : [] };
      }
      return { rows: [] };
    },
  };
}

afterEach(() => {
  clearVisibilityCache();
});

describe("resolveScope", () => {
  it("is All by default, so nothing changes for existing staff (Todd, Andrew, Caden ...)", async () => {
    expect(await resolveScope(fakeDb(), U1, "Staff")).toEqual({ mode: "all", visibility: "all", userId: U1 });
  });

  it("follows the role setting, and a per-user setting beats it", async () => {
    expect(await resolveScope(fakeDb({ roleVis: "own" }), U1, "Staff")).toEqual({ mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] });
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ roleVis: "own", userVis: "all" }), U1, "Staff")).mode).toBe("all");
  });

  it("team: the user and everyone sharing one of their teams", async () => {
    const s = await resolveScope(fakeDb({ roleVis: "team", team: [U1, U2] }), U1, "Staff");
    expect(s).toMatchObject({ mode: "restricted", visibility: "team" });
    expect((s as any).ownerIds.sort()).toEqual([U1, U2].sort());
  });

  it("admins always see everything", async () => {
    const db = fakeDb({ roleVis: "own", userVis: "own" });
    expect((await resolveScope(db, U1, "Admin")).mode).toBe("all");
    expect(db.sqls).toEqual([]);
  });

  it("a custom role takes its own visibility; a built-in Admin is exempt but an Admin-based custom role is not", async () => {
    const builtIn = fakeDb({ roleVis: "team", customVis: "own" });
    expect((await resolveScope(builtIn, U1, "Staff")).visibility).toBe("team");
    expect(builtIn.sqls.some((q) => /custom_roles/.test(q))).toBe(false);
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ roleVis: "all", customVis: "own" }), U1, "Staff", U3)).visibility).toBe("own");
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ userVis: "all", customVis: "own" }), U1, "Staff", U3)).visibility).toBe("all");
    clearVisibilityCache();
    expect((await resolveScope(fakeDb({ customVis: "team" }), U1, "Admin", U3)).visibility).toBe("team");
  });

  it("the assistant without an acting user: all only when the role sees all, else nothing", async () => {
    expect(await resolveRoleOnlyScope(fakeDb(), "Staff")).toBe(ALL_SCOPE);
    expect(await resolveRoleOnlyScope(fakeDb({ roleVis: "own" }), "Staff")).toMatchObject({ mode: "restricted", ownerIds: [] });
    expect(await scopeForActingUser(fakeDb({ roleVis: "own", roleFor: "Staff" }), { staff_user_id: U3 })).toMatchObject({ mode: "restricted", ownerIds: [U3] });
  });

  it("an assistant call naming nobody verified: everything while nobody is restricted, else nothing (a body role is ignored)", async () => {
    expect(await resolveUnverifiedActorScope(fakeDb())).toBe(ALL_SCOPE);
    expect(await resolveUnverifiedActorScope(fakeDb({ anyRestriction: true }))).toMatchObject({ mode: "restricted", ownerIds: [] });
    expect(await scopeForActingUser(fakeDb({ anyRestriction: true }), { role: "Admin" })).toMatchObject({ mode: "restricted", ownerIds: [] });
  });
});

describe("SQL", () => {
  it("adds one owner condition per record type, or nothing for All", () => {
    const params: unknown[] = ["BF"];
    const own = { mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] } as const;
    expect(ownerFilterSql(own, "contact", "c", params)).toBe("c.owner_id = ANY($2::uuid[])");
    expect(ownerFilterSql(own, "application", "a", params)).toBe("a.owner_user_id = ANY($3::uuid[])");
    expect(params).toEqual(["BF", [U1], [U1]]);
    expect(ownerFilterSql(ALL_SCOPE, "company", "co", params)).toBe("TRUE");
    expect(ownerFilterSql({ ...own, ownerIds: [] }, "company", "co", [])).toBe("FALSE");
    expect(() => ownerFilterSql(own, "contact", "c;--", [])).toThrow();
  });

  it("the team filter only ever narrows", () => {
    expect(narrowToOwners(ALL_SCOPE, [U2])).toMatchObject({ mode: "restricted", ownerIds: [U2] });
    expect(narrowToOwners({ mode: "restricted", visibility: "team", userId: U1, ownerIds: [U1, U2] }, [U2, U3])).toMatchObject({ ownerIds: [U2] });
  });

  it("report views filter the three tables by owner and never inline anything but uuids", () => {
    const v = viewSql([U1, "x'); DROP TABLE users; --"]);
    expect(v[0]).toBe(`CREATE OR REPLACE TEMP VIEW applications AS SELECT * FROM public.applications WHERE owner_user_id = ANY(ARRAY['${U1}']::uuid[])`);
    expect(v.join(" ")).not.toContain("DROP TABLE");
    expect(viewSql([])[1]).toContain("ARRAY[]::uuid[]");
  });

  it("canSeeRecord reads nothing for All and checks the owner otherwise", async () => {
    const db = fakeDb({ visible: [U3] });
    expect(await canSeeRecord(db, ALL_SCOPE, "contact", "whatever")).toBe(true);
    expect(db.sqls).toEqual([]);
    const own = { mode: "restricted", visibility: "own", userId: U1, ownerIds: [U1] } as const;
    expect(await canSeeRecord(db, own, "contact", U3)).toBe(true);
    expect(await canSeeRecord(db, own, "contact", U2)).toBe(false);
    expect(await canSeeRecord(db, own, "contact", "not-a-uuid")).toBe(false);
  });
});

describe("recordGuard", () => {
  function app(opts: Opts, role = "Staff") {
    const a = express();
    a.use((req, _res, next) => { (req as any).user = { userId: U1, id: U1, role }; next(); });
    const crm = express.Router();
    crm.use(recordGuard(CRM_RULES, { db: fakeDb(opts) as any }));
    crm.get("/contacts/:id", (req, res) => res.json({ id: req.params.id }));
    crm.get("/contacts/:id/notes", (req, res) => res.json({ notes: [] }));
    crm.post("/contacts/bulk-tag", (_req, res) => res.json({ ok: true }));
    a.use("/api/crm", crm);
    const apps = express.Router();
    apps.use(recordGuard(APPLICATIONS_RULES, { db: fakeDb(opts) as any }));
    apps.get("/:id", (req, res) => res.json({ id: req.params.id }));
    apps.get("/:publicId/required-documents", (_req, res) => res.json({ public: true }));
    apps.get("/rejection-reasons", (_req, res) => res.json({ reasons: [] }));
    a.use("/api/applications", apps);
    return a;
  }

  it("answers 404 for a record the user may not see, on the record and everything under it", async () => {
    const a = app({ roleVis: "own", visible: [U3] });
    expect((await request(a).get(`/api/crm/contacts/${U3}`)).status).toBe(200);
    expect((await request(a).get(`/api/crm/contacts/${U2}`)).status).toBe(404);
    expect((await request(a).get(`/api/crm/contacts/${U2}/notes`)).status).toBe(404);
    expect((await request(a).get(`/api/applications/${U2}`)).status).toBe(404);
  });

  it("leaves list paths, named sub-paths and public routes alone", async () => {
    const a = app({ roleVis: "own", visible: [] });
    expect((await request(a).post(`/api/crm/contacts/bulk-tag`)).status).toBe(200);
    expect((await request(a).get(`/api/applications/rejection-reasons`)).status).toBe(200);
    expect((await request(a).get(`/api/applications/abc/required-documents`)).status).toBe(200);
  });

  it("changes nothing while everyone sees everything", async () => {
    const a = app({});
    expect((await request(a).get(`/api/crm/contacts/${U2}`)).status).toBe(200);
  });

  it("leaves clients and service principals to the route's own checks", async () => {
    const client = app({ roleVis: "own", visible: [] }, "client");
    expect((await request(client).get(`/api/applications/${U2}`)).status).toBe(200);
  });
});

describe("activity views (scopedDb)", () => {
  it("filter messages, conversations, calls, call events, voicemails and tasks by the linked records", () => {
    const names = viewSql([U1], U1).map((q) => /TEMP VIEW (\w+)/.exec(q)?.[1]);
    expect(names).toEqual(["applications", "contacts", "companies", "communications_messages", "communications_conversations", "call_logs", "call_events", "voicemails", "crm_call_log", "tasks"]);
  });

  it("keep tasks assigned to the user, but not for a team filter (no user)", () => {
    expect(viewSql([U1], U1).at(-1)).toContain(`t.assignee_user_id = '${U1}'::uuid OR`);
    expect(viewSql([U1], null).at(-1)).not.toContain("assignee_user_id");
  });
});
