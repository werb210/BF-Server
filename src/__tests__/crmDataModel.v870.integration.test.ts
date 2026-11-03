// BF_SERVER_v870_CRM_DATA_MODEL - batch 3 against real Postgres (baseline + migrations): the migration twice leaves
// every existing person exactly as they were (All visibility, no custom role); custom fields per silo; Team / Own
// record visibility on CRM lists, details, bulk actions, the pipeline, reports, messages, calls, tasks, the duplicate
// banner and the assistant; extra pipelines beside the locked lending pipeline; custom roles enforced by the real
// staff middleware.
//
// Parallel-safe: other test files share this database, so restrictions are set only on this file's own people (a
// per-person override or a custom role), never on a whole built-in role.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { rerunMigration } from "./helpers/rerunMigration.js"; // BF_SERVER_v886_MIGRATION_RERUN
import crmRoutes from "../routes/crm.js";
import companiesRoutes from "../routes/companies.js";
import portalRoutes from "../routes/portal.js";
import applicationsRoutes from "../modules/applications/applications.routes.js";
import reportsRoutes from "../routes/reports.js";
import communicationsRoutes from "../routes/communications.js";
import messagesRoutes from "../routes/messages.js";
import tasksRoutes from "../routes/tasks.js";
import callsRoutes from "../routes/calls.js";
import voiceCallsRoutes from "../routes/voiceCalls.js";
import usersRoutes from "../routes/users.js";
import customFieldsRoutes from "../routes/customFields.js";
import salesTeamsRoutes from "../routes/salesTeams.js";
import pipelinesRoutes from "../routes/pipelines.js";
import rolesRoutes from "../routes/roles.js";
import mayaStaffRouter, { verifyMayaService } from "../routes/mayaStaff.js";
import { mayaActingStaff } from "../services/mayaActingStaff.js";
import { signMayaContext } from "../services/mayaContext.js";
import { clearVisibilityCache, resolveScope } from "../visibility/scope.js";
import { runScoped, scopedAssistantRequest } from "../visibility/scopedDb.js";
import { clearCustomFieldCache } from "../customFields/service.js";
import { clearCustomRoleCache } from "../roles/customRoles.js";
import { templateFor } from "../roles/permissions.js";
import { clearStaffUserCache, dbStaffUserLoader, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";

const MIGRATION = "migrations/2026_11_11_v870_crm_data_model.sql";
// BF_SERVER_v882_DEADLOCK_RETRY - the integration files share one database and run in parallel, so re-running this
// migration's ALTER TABLEs on users / contacts / applications can deadlock with another file's queries (it did on
// 2026-11-02). Postgres aborts one side; the migration is idempotent, so running it again is the right answer.
async function runMigrationRetryingDeadlocks(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await rerunMigration(pool, readFileSync(MIGRATION, "utf8")); return; }
    catch (e: any) {
      if (attempt >= 5 || !["40P01", "55P03"].includes(String(e?.code))) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
}
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), S3 = randomUUID(), S4 = randomUUID();
const PEOPLE = [ADMIN, S1, S2, S3, S4];
const c1 = randomUUID(), c2 = randomUUID(), c3 = randomUUID(), c4 = randomUUID(), c5 = randomUUID(), cBI = randomUUID();
const co1 = randomUUID(), co3 = randomUUID();
const a1 = randomUUID(), a2 = randomUUID(), a3 = randomUUID();
const tMine = randomUUID(), tTheirs = randomUUID(), tAssignedToMe = randomUUID();
const PHONE1 = "+17805550711", PHONE2 = "+17805550722";

const tok = (id: string, role: string, tv = 0) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: tv, tv }, String(process.env.JWT_SECRET))}`;
const svc = () => "Bearer " + jwt.sign({ kind: "service", source: "agent" }, String(process.env.JWT_SECRET), { algorithm: "HS256" });
const ctxFor = (id: string, role = "Staff") => signMayaContext({ audience: "staff", staff: { id, name: null, email: null, role }, silo: "BF" });

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/crm", crmRoutes);
  a.use("/api/companies", companiesRoutes);
  a.use("/api/portal", portalRoutes);
  a.use("/api/applications", applicationsRoutes);
  a.use("/api/reports", reportsRoutes);
  a.use("/api/communications", communicationsRoutes);
  a.use("/api/messages", messagesRoutes);
  a.use("/api/tasks", tasksRoutes);
  a.use("/api/calls", callsRoutes);
  a.use("/api/voice", voiceCallsRoutes);
  a.use("/api/users", usersRoutes);
  a.use("/api/custom-fields", customFieldsRoutes);
  a.use("/api/teams", salesTeamsRoutes);
  a.use("/api/pipelines", pipelinesRoutes);
  a.use("/api/roles", rolesRoutes);
  // The assistant's staff mount, as routeRegistry.ts builds it.
  const maya = express.Router();
  maya.use("/staff", mayaActingStaff((req) => Boolean(verifyMayaService(req))));
  maya.use("/staff", (req, res, next) => (verifyMayaService(req) ? scopedAssistantRequest(req, res, next) : next()));
  maya.use(mayaStaffRouter);
  a.use("/api/maya", maya);
  return a;
}
const http = () => request(app());
const ids = (rows: any[]) => rows.map((r) => String(r.id)).sort();
const has = (rows: any[], key: string, id: string) => (rows ?? []).some((r) => String(r?.[key]) === id);
const fresh = () => { clearStaffUserCache(); clearCustomRoleCache(); clearVisibilityCache(); clearCustomFieldCache(); };
const setVisibility = async (id: string, v: string | null) => {
  await pool.query(`UPDATE users SET record_visibility = $2 WHERE id = $1`, [id, v]);
  fresh();
};

describe("v870 CRM data model (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"], [S3, "Staff", "Sid"], [S4, "Marketing", "Mo"]]) {
      await pool.query(
        `INSERT INTO users (id, email, active, is_active, status, role, first_name, last_name, silo, silos)
         VALUES ($1, $2, true, true, 'ACTIVE', $3, $4, 'V870', 'BF', ARRAY['BF','BI'])`,
        [id, `${first.toLowerCase()}-${tag}@example.com`, role, first],
      );
    }
    const contact = `INSERT INTO contacts (id, name, email, phone, owner_id, silo) VALUES ($1, $2, $3, $4, $5, $6)`;
    await pool.query(contact, [c1, `Vis${tag} One`, `dup-${tag}@example.com`, PHONE1, S1, "BF"]);
    await pool.query(contact, [c2, `Vis${tag} Two`, `dup-${tag}@example.com`, PHONE2, S2, "BF"]);
    await pool.query(contact, [c3, `Vis${tag} Three`, `three-${tag}@example.com`, null, S3, "BF"]);
    await pool.query(contact, [c4, `Vis${tag} Nobody`, `four-${tag}@example.com`, null, null, "BF"]);
    await pool.query(contact, [c5, `Vis${tag} One Too`, `dup-${tag}@example.com`, null, S1, "BF"]);
    await pool.query(contact, [cBI, `Vis${tag} Insurance`, `bi-${tag}@example.com`, null, S1, "BI"]);
    await pool.query(`INSERT INTO companies (id, name, owner_id, silo) VALUES ($1, $2, $3, 'BF'), ($4, $5, $6, 'BF')`,
      [co1, `VisCo${tag} One`, S1, co3, `VisCo${tag} Three`, S3]);
    const appSql = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo, submitted_at, requested_amount)
                    VALUES ($1, $2, now() - interval '20 days', now(), 'Received', 'RECEIVED', $3, $4, 'BF', now(), 100000)`;
    await pool.query(appSql, [a1, `VisApp${tag} One`, c1, S1]);
    await pool.query(appSql, [a2, `VisApp${tag} Two`, c2, S2]);
    await pool.query(appSql, [a3, `VisApp${tag} Three`, c3, S3]);
    const msg = `INSERT INTO communications_messages (id, contact_id, application_id, type, direction, body, from_number, to_number, silo, created_at)
                 VALUES ($1, $2, $3, 'sms', 'inbound', $4, $5, '+17805550100', 'BF', now())`;
    await pool.query(msg, [randomUUID(), c1, null, `sms-mine-${tag}`, PHONE1]);
    await pool.query(msg, [randomUUID(), c2, null, `sms-theirs-${tag}`, PHONE2]);
    const call = `INSERT INTO call_logs (id, crm_contact_id, contact_id, application_id, staff_user_id, direction, status, phone_number, silo, created_at)
                  VALUES ($1, $2, $2, $3, $4, 'outbound', 'completed', $5, 'BF', now())`;
    await pool.query(call, [randomUUID(), c1, a1, S1, PHONE1]);
    await pool.query(call, [randomUUID(), c2, a2, S1, PHONE2]); // S1 dialled Sue's contact: hidden from S1 when restricted
    const task = `INSERT INTO tasks (id, silo, title, assignee_user_id, contact_id) VALUES ($1, 'BF', $2, $3, $4)`;
    await pool.query(task, [tMine, `task-mine-${tag}`, S2, c1]);
    await pool.query(task, [tTheirs, `task-theirs-${tag}`, S2, c2]);
    await pool.query(task, [tAssignedToMe, `task-assigned-${tag}`, S1, c2]);
    fresh();
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[] = []) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean(`UPDATE users SET custom_role_id = NULL, record_visibility = NULL, primary_team_id = NULL WHERE id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM custom_roles WHERE name LIKE $1`, [`%${tag}%`]);
    await clean(`DELETE FROM pipeline_moves WHERE application_id = ANY($1::text[])`, [[a1, a2, a3]]);
    await clean(`UPDATE applications SET pipeline_id = NULL, pipeline_stage_id = NULL WHERE id = ANY($1::text[])`, [[a1, a2, a3]]);
    await clean(`DELETE FROM pipeline_stages WHERE pipeline_id IN (SELECT id FROM pipelines WHERE name LIKE $1)`, [`%${tag}%`]);
    await clean(`DELETE FROM pipelines WHERE name LIKE $1`, [`%${tag}%`]);
    await clean(`DELETE FROM sales_teams WHERE name LIKE $1`, [`%${tag}%`]);
    await clean(`DELETE FROM custom_field_definitions WHERE name LIKE 'v870_%'`);
    await clean(`DELETE FROM tasks WHERE id = ANY($1::uuid[])`, [[tMine, tTheirs, tAssignedToMe]]);
    await clean(`DELETE FROM call_logs WHERE crm_contact_id = ANY($1::uuid[])`, [[c1, c2]]);
    await clean(`DELETE FROM communications_messages WHERE contact_id = ANY($1::uuid[])`, [[c1, c2]]);
    await clean(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[a1, a2, a3]]);
    await clean(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[c1, c2, c3, c4, c5, cBI]]);
    await clean(`DELETE FROM companies WHERE id = ANY($1::uuid[])`, [[co1, co3]]);
    await clean(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [PEOPLE]);
    resetStaffUserLoader();
    fresh();
  });

  it("the migration runs twice and changes nobody's role, visibility or access; built-in roles default to All", async () => {
    const before = (await pool.query(`SELECT id::text, role, record_visibility, custom_role_id, token_version FROM users ORDER BY id`)).rows;
    await runMigrationRetryingDeadlocks();
    await runMigrationRetryingDeadlocks();
    const after = (await pool.query(`SELECT id::text, role, record_visibility, custom_role_id, token_version FROM users ORDER BY id`)).rows;
    expect(after).toEqual(before);
    const roles = (await pool.query(`SELECT role, visibility FROM role_record_visibility WHERE role IN ('Staff', 'Ops', 'Marketing') ORDER BY role`)).rows;
    expect(roles.map((r) => r.role)).toEqual(["Marketing", "Ops", "Staff"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM applications WHERE pipeline_id IS NOT NULL AND id = ANY($1::text[])`, [[a1, a2, a3]])).rows[0].n).toBe(0);
  });

  describe("existing staff keep seeing everything (default All)", () => {
    it("lists, details, the pipeline and the role endpoint are as before", async () => {
      for (const [id, role] of [[S1, "Staff"], [S4, "Marketing"], [ADMIN, "Admin"]]) {
        const r = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(id, role));
        expect(r.status, role).toBe(200);
        expect(ids(r.body.data), role).toEqual([c1, c2, c3, c4, c5].sort());
        expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(id, role))).status, role).toBe(200);
        const pipe = await http().get(`/api/portal/applications`).set("Authorization", tok(id, role));
        expect(pipe.body.applications.map((x: any) => x.id).filter((x: string) => [a1, a2, a3].includes(x)).sort(), role).toEqual([a1, a2, a3].sort());
        const me = await http().get("/api/roles/me").set("Authorization", tok(id, role));
        expect(me.body, role).toMatchObject({ ok: true, role, custom_role: null, record_visibility: "all" });
        expect(me.body.permissions).toEqual(templateFor(role as any));
      }
      expect((await resolveScope(pool as any, S1, "Staff")).mode).toBe("all");
      const teamsMe = await http().get("/api/teams/me").set("Authorization", tok(S1, "Staff"));
      expect(teamsMe.body).toMatchObject({ ok: true, visibility: "all", teams: [] });
    });
  });

  describe("custom fields", () => {
    let tierId = "";
    it("Admins create fields per silo; staff cannot", async () => {
      const r = await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")
        .send({ label: "V870 Tier", name: "v870_tier", field_type: "single_select", options: ["Gold", "Silver"], group_name: "Broker" });
      expect(r.status).toBe(201);
      expect(r.body.field).toMatchObject({ name: "v870_tier", silo: "BF", options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }] });
      tierId = r.body.field.id;
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")
        .send({ label: "V870 Licence", name: "v870_licence", field_type: "text", required: true })).status).toBe(201);
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(S1, "Staff")).send({ label: "Nope", field_type: "text" })).status).toBe(403);
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")
        .send({ label: "V870 Tier", name: "v870_tier", field_type: "text" })).status).toBe(409);
      // The same internal name is free in another silo, and BI does not see BF's fields.
      expect((await http().post("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI")
        .send({ label: "V870 Tier", name: "v870_tier", field_type: "text" })).status).toBe(201);
      const bi = await http().get("/api/custom-fields/contact").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI");
      expect(bi.body.fields.filter((f: any) => f.name.startsWith("v870_")).map((f: any) => [f.name, f.field_type])).toEqual([["v870_tier", "text"]]);
    });

    it("values are validated, saved, listed, filtered and sorted with the record", async () => {
      clearCustomFieldCache();
      const bad = await http().put(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin")).send({ values: { v870_tier: "Platinum" } });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.map((e: any) => e.field).sort()).toEqual(["v870_licence", "v870_tier"]);
      const ok = await http().put(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(S1, "Staff")).send({ values: { v870_tier: "Gold", v870_licence: "AB-1" } });
      expect(ok.status).toBe(200);
      expect(ok.body.values).toMatchObject({ v870_tier: "gold", v870_licence: "AB-1" });
      const patched = await http().patch(`/api/crm/contacts/${c2}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_fields: { v870_tier: "silver" } });
      expect(patched.status).toBe(200);
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}&cf_v870_tier=gold`).set("Authorization", tok(ADMIN, "Admin"));
      expect(ids(list.body.data)).toEqual([c1]);
      expect(list.body.data[0].custom_fields).toMatchObject({ v870_tier: "gold" });
      const sorted = await http().get(`/api/crm/contacts?q=Vis${tag}&sort=cf_v870_tier:asc`).set("Authorization", tok(ADMIN, "Admin"));
      expect(sorted.status).toBe(200);
      // A BI contact is checked against BI's fields (v870_tier is free text there).
      const biVal = await http().put(`/api/custom-fields/contact/records/${cBI}`).set("Authorization", tok(ADMIN, "Admin")).send({ values: { v870_tier: "Platinum" } });
      expect(biVal.status).toBe(200);
    });

    it("archiving hides a field but keeps its values", async () => {
      expect((await http().post(`/api/custom-fields/contact/${tierId}/archive`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")).status).toBe(200);
      const active = await http().get(`/api/custom-fields/contact`).set("Authorization", tok(S1, "Staff"));
      expect(active.body.fields.map((f: any) => f.name)).not.toContain("v870_tier");
      expect((await pool.query(`SELECT custom_fields->>'v870_tier' AS t FROM contacts WHERE id = $1`, [c1])).rows[0].t).toBe("gold");
      const rec = await http().get(`/api/custom-fields/contact/records/${c1}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(rec.body.fields.find((f: any) => f.name === "v870_tier")?.archived_at).toBeTruthy();
      expect((await http().post(`/api/custom-fields/contact/${tierId}/unarchive`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")).status).toBe(200);
    });
  });

  describe("teams and record visibility", () => {
    let teamId = "";
    afterAll(async () => {
      for (const id of [S1, S2]) await setVisibility(id, null);
    });

    it("Own records: list, detail, sub-resources, companies, the pipeline, applications and bulk actions", async () => {
      expect((await http().put(`/api/teams/users/${S1}`).set("Authorization", tok(ADMIN, "Admin")).send({ record_visibility: "own" })).status).toBe(200);
      fresh();
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(list.body.data)).toEqual([c1, c5].sort());
      expect((await http().get(`/api/crm/contacts/${c1}`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      expect((await http().get(`/api/crm/contacts/${c3}/applications`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const cos = await http().get(`/api/crm/companies?q=VisCo${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(cos.body.data)).toEqual([co1]);
      expect((await http().get(`/api/companies/${co3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const pipe = await http().get(`/api/portal/applications`).set("Authorization", tok(S1, "Staff"));
      expect(pipe.body.applications.map((x: any) => x.id).filter((x: string) => [a1, a2, a3].includes(x))).toEqual([a1]);
      expect((await http().get(`/api/portal/applications/${a3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      expect((await http().get(`/api/applications/${a3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const tagged = await http().post(`/api/crm/contacts/bulk-tag`).set("Authorization", tok(S1, "Staff")).send({ ids: [c1, c3], tags: [`t${tag}`], op: "add" });
      expect(tagged.body.updated).toBe(1);
      expect((await pool.query(`SELECT tags FROM contacts WHERE id = $1`, [c3])).rows[0].tags ?? []).not.toContain(`t${tag}`);
      expect((await http().put(`/api/custom-fields/contact/records/${c3}`).set("Authorization", tok(S1, "Staff")).send({ values: {} })).status).toBe(404);
      // Admins always see everything; others on the same role are untouched.
      expect(ids((await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(ADMIN, "Admin"))).body.data)).toEqual([c1, c2, c3, c4, c5].sort());
      expect(ids((await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S3, "Staff"))).body.data)).toEqual([c1, c2, c3, c4, c5].sort());
    });

    it("reports read only the user's records, and the scoped views never outlive a request", async () => {
      const stuck = await http().get(`/api/reports/data/stuck_deals`).set("Authorization", tok(S1, "Staff"));
      expect(stuck.status).toBe(200);
      const items = (stuck.body.items ?? stuck.body.rows ?? []).map((i: any) => String(i.application_id ?? i.id));
      expect(items).not.toContain(a3);
      const scope = await resolveScope(pool as any, S1, "Staff");
      const n = await runScoped(scope, async () => (await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id = ANY($1::text[])`, [[a1, a3]])).rows[0].n);
      expect(n).toBe(1);
      expect((await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id = ANY($1::text[])`, [[a1, a3]])).rows[0].n).toBe(2);
    });

    it("activity: messages, calls, tasks and the duplicate banner show only visible records (tasks assigned to me stay)", async () => {
      const sms = await http().get(`/api/communications/sms?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(sms.status).toBe(200);
      expect(has(sms.body.conversations, "contact_id", c2)).toBe(false);
      const thread = await http().get(`/api/communications/sms/thread?contactId=${c2}`).set("Authorization", tok(S1, "Staff"));
      expect(thread.body.messages ?? []).toEqual([]);
      const adminThread = await http().get(`/api/communications/sms/thread?contactId=${c2}`).set("Authorization", tok(ADMIN, "Admin"));
      expect((adminThread.body.messages ?? []).length).toBe(1);
      const theirCalls = await http().get(`/api/calls?contactId=${c2}`).set("Authorization", tok(S1, "Staff"));
      expect(theirCalls.status).toBe(200);
      expect(theirCalls.body.data.calls).toEqual([]);
      expect((await http().get(`/api/calls?contactId=${c1}`).set("Authorization", tok(S1, "Staff"))).body.data.calls.length).toBe(1);
      const recent = await http().get(`/api/voice/recent-calls`).set("Authorization", tok(S1, "Staff"));
      expect(has(recent.body.items, "contact_id", c2)).toBe(false);
      const tasks = await http().get(`/api/tasks?view=all`).set("Authorization", tok(S1, "Staff"));
      expect(tasks.status).toBe(200);
      const got = (tasks.body.data?.tasks ?? tasks.body.tasks ?? tasks.body.data ?? []).map((t: any) => t.id);
      expect(got).toEqual(expect.arrayContaining([tMine, tAssignedToMe]));
      expect(got).not.toContain(tTheirs);
      expect((await http().patch(`/api/tasks/${tTheirs}`).set("Authorization", tok(S1, "Staff")).send({ title: "x" })).status).toBe(404);
      expect((await pool.query(`SELECT title FROM tasks WHERE id = $1`, [tTheirs])).rows[0].title).toBe(`task-theirs-${tag}`);
      const dup = await http().get(`/api/crm/contacts/${c1}/duplicate-candidates`).set("Authorization", tok(S1, "Staff"));
      expect(dup.status).toBe(200);
      expect((dup.body.data ?? []).map((x: any) => x.id)).not.toContain(c2);
      expect((await http().post(`/api/crm/contacts/merge`).set("Authorization", tok(S1, "Staff")).send({ survivorId: c1, loserIds: [c5] })).status).toBe(403);
      let left = -1;
      for (let i = 0; i < 40 && left !== 0; i++) {
        left = (await pool.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
                                    WHERE ns.nspname LIKE 'pg_temp%' AND c.relname IN ('applications', 'contacts', 'tasks', 'call_logs', 'communications_messages')`)).rows[0].n;
        if (left) await new Promise((r) => setTimeout(r, 50));
      }
      expect(left).toBe(0);
    });

    it("the assistant reads as the signed-in staff member; a mismatched staff_user_id is refused", async () => {
      const find = (headers: Record<string, string>, body: Record<string, unknown>) =>
        http().post("/api/maya/staff/contact-find").set({ Authorization: svc(), ...headers }).send({ query: `Vis${tag}`, silo: "BF", role: "Staff", ...body });
      const mine = await find({ "X-Maya-Context": ctxFor(S1) }, { staff_user_id: S1 });
      expect(mine.status).toBe(200);
      const found = (mine.body.contacts ?? []).map((c: any) => c.id);
      expect(found).not.toContain(c3);
      const admin = await find({ "X-Maya-Context": ctxFor(ADMIN, "Admin") }, { staff_user_id: ADMIN, role: "Admin" });
      expect((admin.body.contacts ?? []).map((c: any) => c.id)).toEqual(expect.arrayContaining([c3]));
      const forged = await find({ "X-Maya-Context": ctxFor(S1) }, { staff_user_id: S3 });
      expect(forged.status).toBe(403);
    });

    it("Team's records: teammates' records too; the Team filter narrows the pipeline", async () => {
      const t = await http().post("/api/teams").set("Authorization", tok(ADMIN, "Admin")).send({ name: `North ${tag}` });
      expect(t.status).toBe(201);
      teamId = t.body.team.id;
      expect((await http().put(`/api/teams/${teamId}/members`).set("Authorization", tok(ADMIN, "Admin")).send({ user_ids: [S1, S2] })).status).toBe(200);
      expect((await pool.query(`SELECT primary_team_id::text AS p FROM users WHERE id = $1`, [S1])).rows[0].p).toBe(teamId);
      expect((await http().put(`/api/teams/users/${S1}`).set("Authorization", tok(ADMIN, "Admin")).send({ record_visibility: "team" })).status).toBe(200);
      fresh();
      const list = await http().get(`/api/crm/contacts?q=Vis${tag}`).set("Authorization", tok(S1, "Staff"));
      expect(ids(list.body.data)).toEqual([c1, c2, c5].sort());
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
      const me = await http().get(`/api/teams/me`).set("Authorization", tok(S1, "Staff"));
      expect(me.body).toMatchObject({ visibility: "team", teams: [{ id: teamId, is_primary: true }] });
      const r = await http().get(`/api/portal/applications?team_id=${teamId}`).set("Authorization", tok(ADMIN, "Admin"));
      expect(r.body.applications.map((x: any) => x.id).filter((x: string) => [a1, a2, a3].includes(x)).sort()).toEqual([a1, a2].sort());
      expect((await http().get("/api/teams").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
      expect((await http().get("/api/teams/options").set("Authorization", tok(S1, "Staff"))).body.teams.some((x: any) => x.id === teamId)).toBe(true);
    });
  });

  describe("extra pipelines", () => {
    const stageBody = [
      { name: "New", color: "#1d4ed8", probability: 10 },
      { name: "Quoted", color: "#b45309", probability: 50 },
      { name: "Won", color: "#15803d", probability: 100, outcome: "won" },
      { name: "Lost", color: "#4b5563", probability: 0, outcome: "lost" },
    ];
    it("Admins add pipelines per silo; the lending stages stay locked; deals move and come back", async () => {
      const lendingOnly = await http().get("/api/pipelines").set("Authorization", tok(S1, "Staff")).set("X-Silo", "BF");
      expect(lendingOnly.body.pipelines[0]).toMatchObject({ id: "lending", system: true });
      expect(lendingOnly.body.pipelines[0].stages.every((s: any) => s.locked)).toBe(true);
      expect(lendingOnly.body.pipelines[0].stages.map((s: any) => s.name)).toContain("Funded");
      expect((await http().post("/api/pipelines").set("Authorization", tok(S1, "Staff")).send({ name: `X ${tag}`, stages: stageBody })).status).toBe(403);
      const made = await http().post("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF").send({ name: `Renewals ${tag}`, stages: stageBody });
      expect(made.status).toBe(201);
      const renewals = made.body.pipeline.id;
      const stages = made.body.pipeline.stages;
      expect((await http().put("/api/pipelines/lending").set("Authorization", tok(ADMIN, "Admin")).send({ name: "Mine", stages: stageBody })).status).toBe(409);
      // BI does not see BF's pipeline.
      const bi = await http().get("/api/pipelines").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI");
      expect(bi.body.pipelines.map((p: any) => p.id)).not.toContain(renewals);

      const mv = await http().post("/api/pipelines/move").set("Authorization", tok(S2, "Staff")).send({ application_id: a2, pipeline_id: renewals, stage_id: stages[1].id });
      expect(mv.body).toMatchObject({ ok: true, pipeline_id: renewals, stage: "Quoted" });
      // The deal leaves the lending board and shows on its own board and report.
      const lend = await http().get(`/api/portal/applications`).set("Authorization", tok(ADMIN, "Admin"));
      expect(lend.body.applications.map((x: any) => x.id)).not.toContain(a2);
      const board = await http().get(`/api/pipelines/${renewals}/board`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF");
      expect(board.body.cards.map((c: any) => c.id)).toEqual([a2]);
      const rep = await http().get(`/api/pipelines/report?pipeline_id=${renewals}`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF");
      expect(rep.body.totals).toMatchObject({ open_deals: 1, open_amount: 100000, weighted_amount: 50000 });
      // A stage with deals in it cannot be removed; a pipeline with deals cannot be archived.
      expect((await http().put(`/api/pipelines/${renewals}`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")
        .send({ name: `Renewals ${tag}`, stages: [stages[0], stages[2], stages[3]] })).status).toBe(409);
      expect((await http().post(`/api/pipelines/${renewals}/archive`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")).status).toBe(409);
      const back = await http().post("/api/pipelines/move").set("Authorization", tok(S2, "Staff")).send({ application_id: a2, pipeline_id: "lending" });
      expect(back.body).toMatchObject({ pipeline_id: "lending", stage: "Received" });
      expect((await pool.query(`SELECT pipeline_state FROM applications WHERE id = $1`, [a2])).rows[0].pipeline_state).toBe("Received");
      expect((await pool.query(`SELECT count(*)::int AS n FROM pipeline_moves WHERE application_id = $1`, [a2])).rows[0].n).toBe(2);
      expect((await http().post(`/api/pipelines/${renewals}/archive`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BF")).status).toBe(200);
    });
  });

  describe("custom roles", () => {
    let roleId = "";
    it("only full Admins create roles; permissions beyond the base are dropped and audited", async () => {
      const body = {
        name: `Viewer ${tag}`, base_role: "Staff", record_visibility: "own",
        permissions: { contacts: { view: true, edit: true }, companies: { view: true }, users: { view: true, edit: true } },
      };
      expect((await http().post("/api/roles").set("Authorization", tok(S3, "Staff")).send(body)).status).toBe(403);
      const made = await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send(body);
      expect(made.status).toBe(201);
      expect(made.body.dropped).toEqual(["users.view", "users.edit"]);
      expect(made.body.role.permissions.contacts).toMatchObject({ view: true, edit: true, delete: false });
      roleId = made.body.role.id;
      expect((await http().post("/api/roles").set("Authorization", tok(ADMIN, "Admin")).send(body)).status).toBe(409);
      const audit = await pool.query(`SELECT event_type FROM audit_events WHERE target_id = $1`, [roleId]);
      expect(audit.rows.map((r) => r.event_type)).toContain("custom_role.created");
      const list = await http().get("/api/roles").set("Authorization", tok(ADMIN, "Admin"));
      expect(list.body.templates.map((t: any) => t.name)).toEqual(["Admin", "Ops", "Staff", "Marketing"]);
      expect(list.body.templates.every((t: any) => t.read_only)).toBe(true);
    });

    it("assigning the role keeps the base role, audits it, and the server enforces the matrix; others are untouched", async () => {
      const res = await http().patch(`/api/users/${S3}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_role_id: roleId });
      expect(res.status).toBe(200);
      expect(res.body.custom_role_id).toBe(roleId);
      const row = (await pool.query(`SELECT role, custom_role_id::text AS custom_role_id, token_version FROM users WHERE id = $1`, [S3])).rows[0];
      expect(row).toMatchObject({ role: "Staff", custom_role_id: roleId });
      fresh();
      const tv = Number(row.token_version ?? 0);
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S3, "Staff", tv))).status).toBe(200);
      expect((await http().get(`/api/crm/contacts/${c2}`).set("Authorization", tok(S3, "Staff", tv))).status).toBe(404); // own only
      const del = await http().post(`/api/crm/contacts/bulk-delete`).set("Authorization", tok(S3, "Staff", tv)).send({ ids: [c3] });
      expect(del.status).toBe(403);
      expect(del.body.error).toBe("permission_denied");
      const me = await http().get("/api/roles/me").set("Authorization", tok(S3, "Staff", tv));
      expect(me.body).toMatchObject({ custom_role: { id: roleId }, record_visibility: "own", full_admin: false });
      // Sue, on built-in Staff, keeps everything.
      expect((await http().get(`/api/crm/contacts/${c3}`).set("Authorization", tok(S2, "Staff"))).status).toBe(200);
      // A role in use cannot be archived; moving back to a built-in role clears the custom role.
      expect((await http().post(`/api/roles/${roleId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(409);
      expect((await http().patch(`/api/users/${S3}`).set("Authorization", tok(ADMIN, "Admin")).send({ role: "Staff" })).status).toBe(200);
      expect((await pool.query(`SELECT custom_role_id FROM users WHERE id = $1`, [S3])).rows[0].custom_role_id).toBeNull();
      expect((await http().post(`/api/roles/${roleId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
      expect((await http().patch(`/api/users/${S2}`).set("Authorization", tok(ADMIN, "Admin")).send({ custom_role_id: roleId })).status).toBe(409);
    });
  });
});
