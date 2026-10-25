// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone line and support queue against real Postgres (baseline + migrations):
// the migration twice, KS-only caller matching, the ring group from presence, queue settings, support calls and
// voicemails onto one ticket, the KS-Ops ingest (create, append, idempotent), SLA, assignment and replies.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const notify = vi.hoisted(() => vi.fn(async () => ({ smsSent: 0, notifsCreated: 0, recipientCount: 0 })));
vi.mock("../services/notifications/notifyAllStaff.js", () => ({ notifyAllStaff: notify }));

import { pool } from "../db.js";
import ksSupportRoutes from "../routes/ksSupport.js";
import { loadQueueSettings, matchKsCaller, parseQueueSettings, queueIsOpen, ringGroup, saveQueueSettings } from "../modules/ks/ksPhone.js";
import { getTicket, listTickets, recordSupportCall, recordSupportVoicemail, replyToTicket, slaDueAt, updateTicket } from "../modules/ks/ksSupport.js";

const MIGRATION = "migrations/2026_10_24_v853_ks_phone_support.sql";
const KEY = "ks-ops-" + "y".repeat(40);
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID();
const KS_STAFF = randomUUID();
const BF_STAFF = randomUUID();
const KS_COMPANY = randomUUID();
const KS_CONTACT = randomUUID();
const BF_CONTACT = randomUUID();
const digits = `403${String(Math.floor(1000000 + Math.random() * 8999999))}`;
const companyDigits = `587${String(Math.floor(1000000 + Math.random() * 8999999))}`;
const CALL_1 = `CA${tag}${"1".repeat(24)}`;
const CALL_2 = `CA${tag}${"2".repeat(24)}`;
const touchedTickets = new Set<string>();
const touchedContacts = new Set<string>([KS_CONTACT, BF_CONTACT]);
const touchedCompanies = new Set<string>([KS_COMPANY]);
const noNotify = { notify: async () => undefined };

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/ks/support", ksSupportRoutes);
  return a;
}

describe("v853 Keystone phone line + support queue (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    process.env.KS_OPS_CRM_KEY = KEY;
    await pool.query(
      `INSERT INTO users (id, email, active, role, first_name, last_name, silo, silos) VALUES
         ($1, $2, true, 'Admin', 'Pat', 'Admin', 'BF', ARRAY['BF']),
         ($3, $4, true, 'Staff', 'Kim', 'Keystone', 'BF', ARRAY['BF','KS']),
         ($5, $6, true, 'Staff', 'Bo', 'Boreal', 'BF', ARRAY['BF'])`,
      [ADMIN, `admin-${tag}@example.com`, KS_STAFF, `ks-${tag}@example.com`, BF_STAFF, `bf-${tag}@example.com`],
    );
    await pool.query(
      `INSERT INTO staff_presence (user_id, status, twilio_identity, last_heartbeat) VALUES
         ($1, 'available', $2, now()), ($3, 'available', $4, now())`,
      [KS_STAFF, `ks-agent-${tag}`, BF_STAFF, `bf-agent-${tag}`],
    );
    await pool.query(
      `INSERT INTO companies (id, name, phone, silo, ks_company_code, ks_support_level) VALUES ($1, $2, $3, 'KS', $4, 'premium')`,
      [KS_COMPANY, `Acme Lending ${tag}`, `+1${companyDigits}`, `ACME-${tag}`],
    );
    await pool.query(
      `INSERT INTO contacts (id, name, first_name, last_name, email, phone, silo, company_id) VALUES
         ($1, 'Ada Lovelace', 'Ada', 'Lovelace', $2, $3, 'KS', $4),
         ($5, 'Bea Boreal', 'Bea', 'Boreal', $6, $3, 'BF', NULL)`,
      [KS_CONTACT, `ada-${tag}@example.com`, `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`, KS_COMPANY, BF_CONTACT, `bea-${tag}@example.com`],
    );
  });

  afterAll(async () => {
    delete process.env.KS_OPS_CRM_KEY;
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    const tickets = [...touchedTickets];
    const contacts = [...touchedContacts];
    const companies = [...touchedCompanies];
    await clean("DELETE FROM ks_support_tickets WHERE id = ANY($1::uuid[]) OR external_id LIKE $2", [tickets, `%${tag}%`]);
    await clean("DELETE FROM call_logs WHERE twilio_call_sid = ANY($1::text[])", [[CALL_1, CALL_2]]);
    await clean("DELETE FROM crm_notes WHERE contact_id = ANY($1::uuid[]) OR company_id = ANY($2::uuid[])", [contacts, companies]);
    await clean("DELETE FROM crm_email_log WHERE contact_id = ANY($1::uuid[])", [contacts]);
    await clean("DELETE FROM contacts WHERE id = ANY($1::uuid[]) OR email LIKE $2", [contacts, `%${tag}%`]);
    await clean("DELETE FROM companies WHERE id = ANY($1::uuid[]) OR ks_company_code LIKE $2", [companies, `%${tag}%`]);
    await clean("DELETE FROM staff_presence WHERE user_id = ANY($1::uuid[])", [[KS_STAFF, BF_STAFF]]);
    await clean("UPDATE ks_phone_queues SET ring_user_ids = '{}'::uuid[] WHERE $1::uuid = ANY(ring_user_ids)", [KS_STAFF]);
    await clean("DELETE FROM users WHERE id = ANY($1::uuid[])", [[ADMIN, KS_STAFF, BF_STAFF]]);
  });

  it("matches a caller to the Keystone contact (never the BF one with the same number), else the Keystone company", async () => {
    const hit = await matchKsCaller(pool, `+1${digits}`);
    expect(hit).toMatchObject({ found: true, contactId: KS_CONTACT, contactName: "Ada Lovelace", companyId: KS_COMPANY, supportLevel: "premium" });
    const company = await matchKsCaller(pool, `+1${companyDigits}`);
    expect(company).toMatchObject({ found: true, contactId: null, companyId: KS_COMPANY });
  });

  it("rings Keystone staff only, and only the named group once one is set", async () => {
    const both = (await ringGroup(pool, { ringUserIds: [] })).map((m) => m.identity);
    expect(both).toContain(`ks-agent-${tag}`);
    expect(both).not.toContain(`bf-agent-${tag}`);
    expect((await ringGroup(pool, { ringUserIds: [ADMIN] })).map((m) => m.identity)).not.toContain(`ks-agent-${tag}`);
    const parsed = parseQueueSettings("support", { ringUserIds: [KS_STAFF], ringTimeoutSeconds: 30, hoursEnabled: false });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await saveQueueSettings(pool, parsed.value, ADMIN);
    const loaded = await loadQueueSettings(pool, "support");
    expect(loaded).toMatchObject({ ringUserIds: [KS_STAFF], ringTimeoutSeconds: 30, hoursEnabled: false });
    expect(queueIsOpen(loaded, new Date("2026-10-25T08:00:00Z"))).toBe(true);
    expect((await ringGroup(pool, loaded)).map((m) => m.identity)).toEqual([`ks-agent-${tag}`]);
  });

  it("support calls and the voicemail land on one ticket with the licensee's SLA; the answered call counts as the reply", async () => {
    const caller = await matchKsCaller(pool, `+1${digits}`);
    const id = (await recordSupportCall(pool, { callSid: CALL_1, from: `+1${digits}`, caller }, noNotify))!;
    touchedTickets.add(id);
    expect(await recordSupportCall(pool, { callSid: CALL_1, from: `+1${digits}`, caller }, noNotify)).toBe(id); // same call: no duplicate
    expect(await recordSupportCall(pool, { callSid: CALL_2, from: `+1${digits}`, caller }, noNotify)).toBe(id); // a second call: same open ticket
    expect(await recordSupportVoicemail(pool, { callSid: CALL_2, from: `+1${digits}`, caller, transcript: "Uploads fail", recordingUrl: "https://blob/vm.mp3" }, noNotify)).toBe(id);

    const t = (await getTicket(pool, id))!;
    expect(t.ticket).toMatchObject({ channel: "phone", status: "new", company_id: KS_COMPANY, contact_id: KS_CONTACT, support_level: "premium", silo: "KS" });
    const created = new Date(t.ticket.created_at!);
    expect(t.ticket.sla_due_at).toBe(slaDueAt("premium", created).toISOString());
    expect(t.messages.map((m) => m.kind)).toEqual(["call", "call", "voicemail"]);
    expect(t.messages[2]!.body).toBe("Voicemail: Uploads fail");

    // The first call was answered by Kim: the call shows who, and the SLA counts it as the first response.
    await pool.query(
      `INSERT INTO call_logs (twilio_call_sid, from_number, direction, status, silo, answered, staff_user_id, crm_contact_id)
       VALUES ($1, $2, 'inbound', 'completed', 'KS', true, $3, $4)`,
      [CALL_1, `+1${digits}`, KS_STAFF, KS_CONTACT],
    );
    const after = (await getTicket(pool, id))!;
    expect(after.messages[0]!.call).toMatchObject({ answered: true, answered_by: "Kim Keystone" });
    expect(after.ticket.responded_at).not.toBeNull();
    expect(["met", "missed"]).toContain(after.ticket.sla_state);
    const listed = await listTickets(pool, { status: "active", companyId: KS_COMPANY });
    expect(listed.map((x) => x.id)).toContain(id);
    // The opening is on the contact's Keystone timeline.
    const notes = await pool.query(`SELECT body, silo FROM crm_notes WHERE contact_id = $1`, [KS_CONTACT]);
    expect(notes.rows.some((r) => /Keystone support ticket #\d+ opened \(phone\)/.test(r.body) && r.silo === "KS")).toBe(true);
  });

  it("KS-Ops in-app help: creates the ticket (company, contact, SLA), appends follow-ups once, refuses a bad key", async () => {
    const body = {
      external_id: `kst-${tag}`, subject: "Cannot upload statements", message: "The upload button does nothing", message_id: `m1-${tag}`,
      licensee: { company_code: `NEWCO-${tag}`, name: `New Co ${tag}`, support_level: "priority" },
      requester: { name: "Nia Newco", email: `nia-${tag}@example.com` },
    };
    expect((await request(app()).post("/api/ks/support/ingest").set("X-KS-Ops-Key", "wrong").send(body)).status).toBe(401);
    const res = await request(app()).post("/api/ks/support/ingest").set("X-KS-Ops-Key", KEY).send(body);
    expect(res.status).toBe(201);
    touchedTickets.add(res.body.ticket_id);
    const t = (await getTicket(pool, res.body.ticket_id))!;
    expect(t.ticket).toMatchObject({ channel: "in_app", support_level: "priority", from_email: `nia-${tag}@example.com`, contact_name: "Nia Newco" });
    expect(t.ticket.company_name).toBe(`New Co ${tag}`);
    const co = await pool.query(`SELECT silo, ks_support_level FROM companies WHERE id = $1`, [t.ticket.company_id]);
    expect(co.rows[0]).toEqual({ silo: "KS", ks_support_level: "priority" });

    const again = await request(app()).post("/api/ks/support/ingest").set("X-KS-Ops-Key", KEY).send({ ...body, message: "Still broken", message_id: `m2-${tag}` });
    expect(again.body).toMatchObject({ created: false, appended: true, ticket_id: res.body.ticket_id });
    const dup = await request(app()).post("/api/ks/support/ingest").set("X-KS-Ops-Key", KEY).send({ ...body, message: "Still broken", message_id: `m2-${tag}` });
    expect(dup.body).toMatchObject({ created: false, appended: false });
    expect((await getTicket(pool, res.body.ticket_id))!.messages.map((m) => m.body)).toEqual(["The upload button does nothing", "Still broken"]);
  });

  it("assignment, a reply (counted as the first response) and resolving", async () => {
    const caller = await matchKsCaller(pool, `+1${digits}`);
    const [ticket] = await listTickets(pool, { status: "active", contactId: KS_CONTACT });
    expect(ticket).toBeTruthy();
    expect(caller.contactId).toBe(KS_CONTACT);
    const refused = await updateTicket(pool, ticket!.id, { assignee_user_id: BF_STAFF }, { userId: ADMIN, name: "Pat Admin" }, noNotify);
    expect(refused).toEqual({ ok: false, error: "assignee_not_keystone_staff", status: 400 });
    expect(await updateTicket(pool, ticket!.id, { assignee_user_id: KS_STAFF, priority: "high" }, { userId: ADMIN, name: "Pat Admin" }, noNotify)).toEqual({ ok: true });
    const sent: string[] = [];
    const out = await replyToTicket(pool, ticket!.id, { channel: "email", body: "Fixed, please retry", status: "waiting" }, { userId: KS_STAFF, name: "Kim Keystone" }, {
      email: async ({ to }) => { sent.push(to); return { ok: true, from: "support@keystone.example" }; },
      sms: async () => ({ ok: false, error: "unused" }),
    });
    expect(out).toEqual({ ok: true, to: `ada-${tag}@example.com` });
    expect(sent).toEqual([`ada-${tag}@example.com`]);
    const t = (await getTicket(pool, ticket!.id))!;
    expect(t.ticket).toMatchObject({ status: "waiting", priority: "high", assignee_user_id: KS_STAFF, assignee_name: "Kim Keystone" });
    expect(t.messages.map((m) => m.kind)).toEqual(expect.arrayContaining(["system", "reply"]));
    const email = await pool.query(`SELECT silo, to_addresses FROM crm_email_log WHERE contact_id = $1`, [KS_CONTACT]);
    expect(email.rows[0]).toEqual({ silo: "KS", to_addresses: [`ada-${tag}@example.com`] });
    expect(await updateTicket(pool, ticket!.id, { status: "resolved" }, { userId: ADMIN, name: "Pat Admin" }, noNotify)).toEqual({ ok: true });
    const done = (await getTicket(pool, ticket!.id))!;
    expect(done.ticket.status).toBe("resolved");
    expect(done.ticket.resolved_at).not.toBeNull();
  });
});
