// BF_SERVER_v831_DIALER_POLISH - batch 3 SQL against the real schema: resent tasks are made once, Recents shows missed
// incoming calls with their sid, and the caller ID list covers every contact.
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";
import tasksRouter from "../routes/tasks.js";
import voiceCallsRouter from "../routes/voiceCalls.js";

const tag = "v831" + Math.floor(Math.random() * 1e6);
const staff = randomUUID();
const contact = randomUUID();
const missedSid = `CA${tag}missed`;
const answeredSid = `CA${tag}answered`;
const auth = () => `Bearer ${staffToken("Staff", staff)}`;

describe("v831 dialler polish against the real schema", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users (id, email, active, role, first_name) VALUES ($1, $2, true, 'Staff', 'Pat')", [staff, `${staff}@${tag}.test`]);
    await pool.query("INSERT INTO contacts (id, name, phone, silo) VALUES ($1, $2, '(403) 555-0177', 'BF')", [contact, `Caller ${tag}`]);
    await pool.query(
      `INSERT INTO call_logs (twilio_call_sid, phone_number, from_number, direction, status, silo)
       VALUES ($1, '+15875550101', '+15875550101', 'inbound', 'completed', 'BF'), ($2, '+15875550102', '+15875550102', 'inbound', 'completed', 'BF')`,
      [missedSid, answeredSid],
    );
    await pool.query(`UPDATE call_logs SET staff_user_id = $2, answered_leg_sid = 'CA-leg-${tag}', answered = true WHERE twilio_call_sid = $1`, [answeredSid, staff]);
  });
  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM tasks WHERE title = $1", [`Follow up ${tag}`]);
    await clean("DELETE FROM dialer_request_keys WHERE user_id = $1", [staff]);
    await clean("DELETE FROM call_logs WHERE twilio_call_sid = ANY($1)", [[missedSid, answeredSid]]);
    await clean("DELETE FROM contacts WHERE id = $1", [contact]);
    await clean("DELETE FROM users WHERE id = $1", [staff]);
  });

  it("a task sent twice with the same Idempotency-Key is made once", async () => {
    const app = mountRouter(tasksRouter, "/api/tasks");
    const key = randomUUID();
    const send = () => request(app).post("/api/tasks").set("Authorization", auth()).set("Idempotency-Key", key)
      .send({ title: `Follow up ${tag}`, type: "TODO", priority: "MEDIUM" });
    const first = await send();
    expect(first.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 50));
    const again = await send();
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    const made = await pool.query("SELECT count(*)::int AS c FROM tasks WHERE title = $1", [`Follow up ${tag}`]);
    expect(made.rows[0].c).toBe(1);
  });

  it("Recents shows the unanswered incoming call as missed, the answered one as before, both with their sid", async () => {
    const res = await request(mountRouter(voiceCallsRouter, "/api/voice")).get("/api/voice/recent-calls").set("Authorization", auth());
    expect(res.status).toBe(200);
    const bySid = new Map((res.body.items as any[]).map((i) => [i.call_sid, i]));
    expect(bySid.get(missedSid)?.status).toBe("missed");
    expect(bySid.get(answeredSid)?.status).toBe("completed");
  });

  it("the caller ID list includes the contact, in E.164", async () => {
    const res = await request(mountRouter(voiceCallsRouter, "/api/voice")).get("/api/voice/caller-directory").set("Authorization", auth()).set("X-Silo", "BF");
    expect(res.status).toBe(200);
    expect(res.body.entries).toContainEqual({ number: "+14035550177", label: `Caller ${tag}` });
  });
});
