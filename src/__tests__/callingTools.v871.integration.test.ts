// BF_SERVER_v871_CALLING_TOOLS - call scripts and call queues against real Postgres (baseline + migrations): the
// migration twice, scripts per silo with answers on the timeline and in custom fields, record visibility on runs, and
// a queue call from waiting to answered (Twilio stubbed at the edge).
//
// Parallel-safe: other test files share this database. Restrictions are set on this file's own people only (a
// per-person record visibility), the main-line queue setting is never written, and every row is this file's own.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { clearVisibilityCache } from "../visibility/scope.js";
import { clearCustomFieldCache } from "../customFields/service.js";
import { clearStaffUserCache, dbStaffUserLoader, resetStaffUserLoader, setStaffUserLoader } from "../auth/staffUserState.js";
import { markReady } from "../startupState.js";
import { deps } from "../system/deps.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";
import callScriptsRoutes from "../routes/callScripts.js";
import callQueuesRoutes from "../routes/callQueues.js";
import callQueueWebhooksRoutes from "../routes/callQueueWebhooks.js";
import { enqueueCaller, getQueue, setQueueTwilioForTests } from "../callQueues/queues.js";

vi.mock("../middleware/twilioWebhookValidation.js", () => ({ twilioWebhookValidation: (_req: any, _res: any, next: any) => next() }));

const MIGRATION = "migrations/2026_11_12_v871_calling_tools.sql";
const tag = randomUUID().slice(0, 8);
const ADMIN = randomUUID(), S1 = randomUUID(), S2 = randomUUID(), M1 = randomUUID();
const PEOPLE = [ADMIN, S1, S2, M1];
const C1 = randomUUID(), C2 = randomUUID(), A1 = randomUUID();
const tok = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, id, role, tokenVersion: 0, tv: 0 }, String(process.env.JWT_SECRET))}`;

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/call-scripts", callScriptsRoutes);
  a.use("/api/call-queues", callQueuesRoutes);
  a.use("/api/webhooks/twilio/queue", callQueueWebhooksRoutes);
  return a;
}
const http = () => request(app());
const fresh = () => { clearStaffUserCache(); clearVisibilityCache(); clearCustomFieldCache(); };

describe("v871 calling tools (real Postgres)", () => {
  beforeAll(async () => {
    markReady();
    deps.db.client = pool;
    deps.db.ready = true;
    setStaffUserLoader(dbStaffUserLoader, { cache: false });
    const sql = readFileSync(MIGRATION, "utf8");
    await pool.query(sql);
    await pool.query(sql); // safe to run again
    for (const [id, role, first] of [[ADMIN, "Admin", "Ada"], [S1, "Staff", "Sam"], [S2, "Staff", "Sue"], [M1, "Marketing", "Mia"]]) {
      await pool.query(
        `INSERT INTO users (id, email, active, is_active, status, role, first_name, last_name, silo, silos)
         VALUES ($1, $2, true, true, 'ACTIVE', $3, $4, 'V871', 'BF', ARRAY['BF','BI'])`,
        [id, `${first.toLowerCase()}-${tag}@example.com`, role, first],
      );
    }
    const contact = `INSERT INTO contacts (id, name, email, phone, owner_id, silo) VALUES ($1, $2, $3, $4, $5, 'BF')`;
    await pool.query(contact, [C1, `Cs${tag} One`, `one-${tag}@example.com`, "+14035550711", S1]);
    await pool.query(contact, [C2, `Cs${tag} Two`, `two-${tag}@example.com`, "+14035550712", S2]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, owner_user_id, silo, submitted_at, requested_amount)
       VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', $3, $4, 'BF', now(), 100000)`, [A1, `CsApp${tag}`, C1, S1]);
    fresh();
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[] = []) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    setQueueTwilioForTests(null);
    await clean(`DELETE FROM call_queue_calls WHERE queue_id IN (SELECT id FROM call_queues WHERE name LIKE $1)`, [`%${tag}%`]);
    await clean(`DELETE FROM call_queue_members WHERE queue_id IN (SELECT id FROM call_queues WHERE name LIKE $1)`, [`%${tag}%`]);
    await clean(`DELETE FROM call_queues WHERE name LIKE $1`, [`%${tag}%`]);
    await clean(`DELETE FROM call_queue_agents WHERE user_id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM staff_presence WHERE user_id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM call_script_runs WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await clean(`DELETE FROM call_scripts WHERE name LIKE $1 OR created_by = $2::uuid`, [`%${tag}%`, ADMIN]);
    await clean(`DELETE FROM custom_field_definitions WHERE name = $1`, [`v871_band_${tag}`]);
    await clean(`DELETE FROM crm_timeline_events WHERE contact_id = ANY($1::uuid[])`, [[C1, C2]]);
    await clean(`DELETE FROM conferences WHERE friendly_name LIKE $1`, [`%${tag}%`]);
    await clean(`DELETE FROM applications WHERE id = $1`, [A1]);
    await clean(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [[C1, C2]]);
    await clean(`DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[])`, [PEOPLE]);
    await clean(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [PEOPLE]);
    resetStaffUserLoader();
  });

  // BF_SERVER_v887_MY_QUEUE_SWITCH - My Profile shows the queue switch to Marketing as well; only its own switch.
  it("Marketing reads and sets its own queue switch, but not the Admin live panel", async () => {
    const me = await http().get("/api/call-queues/me").set("Authorization", tok(M1, "Marketing"));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ ok: true, available: false, queues: [] });
    expect((await http().put("/api/call-queues/me").set("Authorization", tok(M1, "Marketing")).send({ available: true })).body).toMatchObject({ ok: true, available: true });
    expect((await http().put("/api/call-queues/me").set("Authorization", tok(M1, "Marketing")).send({ available: false })).status).toBe(200);
    expect((await http().get("/api/call-queues/live").set("Authorization", tok(M1, "Marketing"))).status).toBe(403);
  });

  describe("call scripts", () => {
    let scriptId = "";
    const field = `v871_band_${tag}`;

    it("Admins build a script whose answer maps to a contact custom field; staff cannot", async () => {
      await pool.query(`INSERT INTO custom_field_definitions (silo, object_type, name, label, field_type, options) VALUES ('BF', 'contact', $1, 'Band', 'single_select', $2::jsonb)`,
        [field, JSON.stringify([{ value: "a", label: "A" }, { value: "b", label: "B" }])]);
      fresh();
      const body = {
        name: `Renewal ${tag}`, use_for: "calls",
        sections: [{ title: "Check-in", body: "Ask how the last deal went.", questions: [
          { id: "band", label: "Band", type: "single_select", options: ["A", "B"], required: true, maps_to: { object: "contact", field } },
          { id: "notes", label: "Notes", type: "long_text" },
        ] }],
      };
      expect((await http().post("/api/call-scripts").set("Authorization", tok(S1, "Staff")).send(body)).status).toBe(403);
      const r = await http().post("/api/call-scripts").set("Authorization", tok(ADMIN, "Admin")).send(body);
      expect(r.status).toBe(201);
      expect(r.body.script.silo).toBe("BF");
      scriptId = r.body.script.id;
      const list = await http().get("/api/call-scripts").set("Authorization", tok(S1, "Staff"));
      expect(list.body.scripts.map((x: any) => x.name)).toContain(`Renewal ${tag}`);
      expect(list.body.custom_fields.contact.map((f: any) => f.name)).toContain(field);
      // Boreal Insurance keeps its own scripts.
      const bi = await http().get("/api/call-scripts").set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI");
      expect(bi.body.silo).toBe("BI");
      expect(bi.body.scripts.map((x: any) => x.name)).not.toContain(`Renewal ${tag}`);
    });

    it("a finished run lands on the timeline and fills the custom field", async () => {
      const missing = await http().post("/api/call-scripts/runs").set("Authorization", tok(S1, "Staff")).send({ script_id: scriptId, contact_id: C1, answers: {}, finish: true });
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe("Answer: Band");
      const started = await http().post("/api/call-scripts/runs").set("Authorization", tok(S1, "Staff")).send({ script_id: scriptId, application_id: A1, answers: { notes: "Going well" } });
      expect(started.status).toBe(201);
      expect(started.body.run).toMatchObject({ contact_id: C1, application_id: A1, status: "in_progress" });
      const done = await http().put(`/api/call-scripts/runs/${started.body.run.id}`).set("Authorization", tok(S1, "Staff")).send({ answers: { band: "B", notes: "Going well" }, finish: true });
      expect(done.status).toBe(200);
      expect(done.body.run).toMatchObject({ status: "completed", field_updates: [{ object: "contact", field }], field_errors: [] });
      expect((await pool.query(`SELECT custom_fields->>$2 AS v FROM contacts WHERE id = $1`, [C1, field])).rows[0].v).toBe("b");
      const tl = await loadCrmTimeline(true, C1, "BF");
      const entry = tl.find((t: any) => t.title === `Call script: Renewal ${tag}`);
      expect(entry?.body).toContain("Band: B");
      expect((await http().put(`/api/call-scripts/runs/${started.body.run.id}`).set("Authorization", tok(S1, "Staff")).send({ answers: {} })).status).toBe(409);
      const runs = await http().get(`/api/call-scripts/runs?contact_id=${C1}`).set("Authorization", tok(S1, "Staff"));
      expect(runs.body.runs[0]).toMatchObject({ script_name: `Renewal ${tag}`, user_name: "Sam V871" });
    });

    it("someone limited to their own records cannot run a script on another person's contact", async () => {
      await pool.query(`UPDATE users SET record_visibility = 'own' WHERE id = $1`, [S2]);
      fresh();
      try {
        expect((await http().post("/api/call-scripts/runs").set("Authorization", tok(S2, "Staff")).send({ script_id: scriptId, contact_id: C1, answers: {} })).status).toBe(404);
        expect((await http().get(`/api/call-scripts/runs?contact_id=${C1}`).set("Authorization", tok(S2, "Staff"))).status).toBe(404);
      } finally {
        await pool.query(`UPDATE users SET record_visibility = NULL WHERE id = $1`, [S2]);
        fresh();
      }
    });

    it("archive, restore and duplicate stay in the silo", async () => {
      const dup = await http().post(`/api/call-scripts/${scriptId}/duplicate`).set("Authorization", tok(ADMIN, "Admin"));
      expect(dup.status).toBe(201);
      expect(dup.body.script.name).toBe(`Renewal ${tag} (copy)`);
      expect((await http().post(`/api/call-scripts/${scriptId}/archive`).set("Authorization", tok(ADMIN, "Admin")).set("X-Silo", "BI")).status).toBe(404);
      expect((await http().post(`/api/call-scripts/${scriptId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).body.script.archived_at).not.toBeNull();
      const list = await http().get("/api/call-scripts").set("Authorization", tok(S1, "Staff"));
      expect(list.body.scripts.map((x: any) => x.id)).not.toContain(scriptId);
    });
  });

  describe("call queues", () => {
    let queueId = "";
    const calls: any[] = [];
    const updates: any[] = [];
    const flush = () => new Promise((r) => setTimeout(r, 200));
    const twiml = async (path: string, body: Record<string, string>) => (await http().post(`/api/webhooks/twilio/queue/${path}`).type("form").send(body));
    const sid = (n: number) => `CA${String(n).padStart(32, "0")}`;

    beforeAll(async () => {
      setQueueTwilioForTests({
        createCall: async (args) => { calls.push(args); return { sid: sid(calls.length) }; },
        updateCall: async (s, args) => { updates.push({ sid: s, ...args }); },
        dequeueMember: async () => {},
      });
      for (const [id, identity] of [[S1, `sam_${tag}`], [S2, `sue_${tag}`]]) {
        await pool.query(`INSERT INTO staff_presence (user_id, status, twilio_identity, last_heartbeat) VALUES ($1, 'available', $2, now())
                          ON CONFLICT (user_id) DO UPDATE SET status = 'available', twilio_identity = $2, last_heartbeat = now(), on_call = false, manual_busy = false`, [id, identity]);
      }
    });

    it("Admins build a queue; staff cannot", async () => {
      expect((await http().get("/api/call-queues").set("Authorization", tok(S1, "Staff"))).status).toBe(403);
      const bad = await http().post("/api/call-queues").set("Authorization", tok(ADMIN, "Admin")).send({ name: `Sales ${tag}`, member_ids: [] });
      expect(bad.status).toBe(400);
      expect(bad.body.errors.member_ids).toBeTruthy();
      const r = await http().post("/api/call-queues").set("Authorization", tok(ADMIN, "Admin"))
        .send({ name: `Sales ${tag}`, greeting: "Thanks for calling. Someone will be with you shortly.", hold_message: "Thanks for waiting.", member_ids: [S1, S2], max_wait_seconds: 120, ring_seconds: 15, overflow: "ask" });
      expect(r.status).toBe(201);
      queueId = r.body.queue.id;
      expect(r.body.queue).toMatchObject({ silo: "BF", overflow: "ask", member_ids: expect.arrayContaining([S1, S2]) });
    });

    it("a caller waits, hears their place in line, and is offered to the longest-free member; a missed offer goes to the next", async () => {
      await pool.query(`INSERT INTO call_queue_agents (user_id, available, available_since) VALUES ($1, true, now() - interval '10 minutes'), ($2, true, now() - interval '1 minute')
                        ON CONFLICT (user_id) DO UPDATE SET available = true, available_since = EXCLUDED.available_since, last_call_ended_at = NULL, last_missed_at = NULL`, [S1, S2]);
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      const v = new VoiceResponse();
      expect(await enqueueCaller(pool, v, (await getQueue(pool as any, queueId))!, { callSid: `CAcaller1${tag}`, from: "+14035550711", callerName: "Pat", contactId: C1 })).toBe(true);
      expect(v.toString()).toContain(`bf-q-${queueId}</Enqueue>`);
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller1${tag}`])).rows[0].id;
      const wait = await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "3", QueueSid: "QU1", CallSid: `CAcaller1${tag}` });
      expect(wait.text).toContain("Thanks for calling. Someone will be with you shortly.");
      expect(wait.text).toContain("You are next in line.");
      expect(wait.text).toContain("<Play>");
      await flush();
      expect(calls).toHaveLength(1);
      expect(String(calls[0].to)).toMatch(new RegExp(`^client:sam_${tag}\\?`));
      expect(String(calls[0].to)).toContain("callerName=Pat");
      expect(String(calls[0].to)).toContain(`callerCompany=Sales%20${tag}%20queue%20call`);
      expect(String(calls[0].to)).toContain("callerNumber=%2B14035550711");
      // Sam does not answer: Sue is offered the caller.
      expect((await twiml(`agent-status?qc=${id}&user=${S1}`, { CallStatus: "no-answer", CallSid: sid(1) })).status).toBe(204);
      await flush();
      expect(calls).toHaveLength(2);
      expect(String(calls[1].to)).toMatch(new RegExp(`^client:sue_${tag}\\?`));
      const live = await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"));
      const q = live.body.queues.find((x: any) => x.id === queueId);
      expect(q.waiting[0]).toMatchObject({ position: 1, caller_name: "Pat", ringing: "Sue V871" });
      // Sue answers: she is connected to the caller Twilio dequeues.
      const bridge = await twiml(`bridge?qc=${id}`, { CallSid: sid(2) });
      expect(bridge.text).toContain(`<Queue url="/api/webhooks/twilio/queue/connecting?qc=${id}" method="POST">bf-q-${queueId}</Queue>`);
      await twiml(`connecting?qc=${id}`, { CallSid: `CAcaller1${tag}`, DequeingCallSid: sid(2) });
      const connected = (await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"))).body.queues.find((x: any) => x.id === queueId);
      expect(connected.connected[0]).toMatchObject({ caller_name: "Pat", agent: "Sue V871" });
      expect(connected.waiting).toEqual([]);
      await twiml(`agent-done?qc=${id}&user=${S2}`, { DialCallStatus: "completed" });
      const row = (await pool.query(`SELECT status, answered_user_id::text AS who FROM call_queue_calls WHERE id = $1`, [id])).rows[0];
      expect(row).toMatchObject({ status: "completed", who: S2 });
      const today = (await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"))).body.queues.find((x: any) => x.id === queueId).today;
      expect(today.answered).toBe(1);
    });

    it("past the longest wait the caller can ask for a callback; staff mark it done", async () => {
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      await pool.query(`UPDATE call_queue_agents SET available = false WHERE user_id = ANY($1::uuid[])`, [[S1, S2]]);
      await enqueueCaller(pool, new VoiceResponse(), (await getQueue(pool as any, queueId))!, { callSid: `CAcaller2${tag}`, from: "+14035550799", callerName: null, contactId: null });
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller2${tag}`])).rows[0].id;
      const wait = await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "130", QueueSid: "QU1" });
      expect(wait.text).toContain("<Leave/>");
      const left = await twiml(`left?qc=${id}`, { QueueResult: "leave", QueueTime: "130" });
      expect(left.text).toContain("press 1");
      const choice = await twiml(`overflow-choice?qc=${id}`, { Digits: "1" });
      expect(choice.text).toContain("We will call you back");
      const live = await http().get("/api/call-queues/live").set("Authorization", tok(ADMIN, "Admin"));
      expect(live.body.callbacks.map((c: any) => c.from_number)).toContain("+14035550799");
      expect((await http().post(`/api/call-queues/callbacks/${id}/done`).set("Authorization", tok(S1, "Staff"))).status).toBe(200);
      expect((await http().post(`/api/call-queues/callbacks/${id}/done`).set("Authorization", tok(S1, "Staff"))).status).toBe(404);
    });

    it("staff switch themselves available; a caller who hangs up stops the agent's phone ringing; an empty queue archives", async () => {
      const me = await http().put("/api/call-queues/me").set("Authorization", tok(S1, "Staff")).send({ available: true });
      expect(me.body.available).toBe(true);
      expect((await http().get("/api/call-queues/me").set("Authorization", tok(S1, "Staff"))).body).toMatchObject({ available: true, queues: [`Sales ${tag}`] });
      const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
      await enqueueCaller(pool, new VoiceResponse(), (await getQueue(pool as any, queueId))!, { callSid: `CAcaller3${tag}`, from: "+14035550777", callerName: null, contactId: null });
      const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [`CAcaller3${tag}`])).rows[0].id;
      await twiml(`wait?qc=${id}`, { QueuePosition: "1", QueueTime: "2", QueueSid: "QU1" });
      await flush();
      expect((await pool.query(`SELECT status FROM call_queue_calls WHERE id = $1`, [id])).rows[0].status).toBe("offered");
      expect((await http().post(`/api/call-queues/${queueId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(409);
      await twiml(`left?qc=${id}`, { QueueResult: "hangup" });
      expect((await pool.query(`SELECT status FROM call_queue_calls WHERE id = $1`, [id])).rows[0].status).toBe("abandoned");
      expect(updates.at(-1)).toMatchObject({ status: "canceled" });
      expect((await http().post(`/api/call-queues/${queueId}/archive`).set("Authorization", tok(ADMIN, "Admin"))).status).toBe(200);
    });
  });
});
