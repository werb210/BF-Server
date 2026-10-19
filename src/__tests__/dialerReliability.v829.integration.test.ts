// BF_SERVER_v829_DIALER_RELIABILITY - the call attribution and outbound SQL against the real schema.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { claimInboundCall, findCallForStaff } from "../modules/calls/callAttribution.js";
import { dialPendingCallees, handleUnansweredCallee } from "../voice/outboundCallFlow.js";

const staff = randomUUID();
const other = randomUUID();
const hex = () => randomUUID().replace(/-/g, "");
const parent = "CA" + hex();
const leg = "CA" + hex();
const oldParent = "CA" + hex();
const oldLeg = "CA" + hex();
const confId = randomUUID();
const outConf = randomUUID();
const tag = "v829" + Math.floor(Math.random() * 1e6);

describe("v829 dialler reliability against the real schema", () => {
  beforeAll(async () => {
    for (const id of [staff, other]) {
      await pool.query("INSERT INTO users (id, email, active) VALUES ($1, $2, true)", [id, `${id}@${tag}.test`]);
    }
    await pool.query(`INSERT INTO staff_presence (user_id, twilio_identity) VALUES ($1, $2)`, [staff, `device-${tag}`]);
    // A new inbound call (logged under the caller's sid, nobody on it yet).
    await pool.query(`INSERT INTO call_logs (twilio_call_sid, direction, status, phone_number) VALUES ($1, 'inbound', 'initiated', '+15875550100')`, [parent]);
    // A call answered before v829 through ring-all: only the conference knows the staff leg.
    await pool.query(`INSERT INTO call_logs (twilio_call_sid, direction, status, phone_number) VALUES ($1, 'inbound', 'completed', '+15875550101')`, [oldParent]);
    await pool.query(`INSERT INTO conferences (id, friendly_name, direction) VALUES ($1, $2, 'inbound')`, [confId, `in_${tag}`]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, twilio_call_sid, status) VALUES ($1, 'pstn', $2, 'left')`, [confId, oldParent]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, identity, twilio_call_sid, status) VALUES ($1, 'staff', $2, $3, 'left')`, [confId, `device-${tag}`, oldLeg]);
    // An outbound call waiting for the staff leg.
    await pool.query(`INSERT INTO conferences (id, friendly_name, direction, created_by_user_id) VALUES ($1, $2, 'outbound', $3)`, [outConf, `out_${tag}`, staff]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, identity, role, status) VALUES ($1, 'staff', $2, 'moderator', 'joined')`, [outConf, staff]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, phone_number, role, status) VALUES ($1, 'pstn', '+15875550102', 'participant', 'pending_dial')`, [outConf]);
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM call_logs WHERE twilio_call_sid = ANY($1::text[])", [[parent, oldParent]]);
    await clean("DELETE FROM conference_participants WHERE conference_id = ANY($1::uuid[])", [[confId, outConf]]);
    await clean("DELETE FROM conferences WHERE id = ANY($1::uuid[])", [[confId, outConf]]);
    await clean("DELETE FROM dialer_client_events WHERE user_id = $1", [staff]);
    await clean("DELETE FROM staff_presence WHERE user_id = $1", [staff]);
    await clean("DELETE FROM users WHERE id = ANY($1::uuid[])", [[staff, other]]);
  });

  it("records who answered and finds the call from their leg's sid", async () => {
    expect(await findCallForStaff(pool, { kind: "sid", value: leg }, staff)).toBeNull();
    expect(await claimInboundCall(pool, { parentCallSid: parent, answeredLegSid: leg, identity: `device-${tag}` })).toBe(true);
    const found = await findCallForStaff(pool, { kind: "sid", value: leg }, staff);
    expect(found?.id).toBeTruthy();
    expect(await findCallForStaff(pool, { kind: "sid", value: leg }, other)).toBeNull();
    expect(await findCallForStaff(pool, { kind: "id", value: found!.id }, staff)).toMatchObject({ id: found!.id });
    // A second answer (another device) never takes it over.
    expect(await claimInboundCall(pool, { parentCallSid: parent, answeredLegSid: "CA" + hex(), staffUserId: other })).toBe(false);
  });

  it("finds an older ring-all call through the conference and claims it for that staff member", async () => {
    expect(await findCallForStaff(pool, { kind: "sid", value: oldLeg }, other)).toBeNull();
    const found = await findCallForStaff(pool, { kind: "sid", value: oldLeg }, staff);
    expect(found?.id).toBeTruthy();
    const row = await pool.query("SELECT staff_user_id::text AS s, answered_leg_sid FROM call_logs WHERE id = $1", [found!.id]);
    expect(row.rows[0]).toEqual({ s: staff, answered_leg_sid: oldLeg });
  });

  it("claims the waiting customer once, and keeps why an unanswered one ended", async () => {
    let dialled: any = null;
    const n = await dialPendingCallees(outConf, { dialPstn: async (args) => { dialled = args; return { callSid: "CA" + hex() }; }, callerId: async () => "+18255550199" });
    expect(n).toBe(1);
    expect(dialled).toMatchObject({ conferenceId: outConf, conferenceFriendly: `out_${tag}`, toNumber: "+15875550102", fromNumber: "+18255550199" });
    expect(await dialPendingCallees(outConf, { dialPstn: async () => ({ callSid: "x" }), callerId: async () => "+1" })).toBe(0);
    const callee = await pool.query("SELECT * FROM conference_participants WHERE conference_id = $1 AND kind = 'pstn'", [outConf]);
    const ended: string[] = [];
    expect(await handleUnansweredCallee(callee.rows[0], "busy", { endStaff: async (_c, m) => { ended.push(m); } })).toBe("busy");
    expect(ended).toEqual(["The line is busy."]);
    const after = await pool.query("SELECT status FROM conference_participants WHERE id = $1", [callee.rows[0].id]);
    expect(after.rows[0].status).toBe("busy");
  });

  it("stores the dialler's events", async () => {
    await pool.query(
      `INSERT INTO dialer_client_events (user_id, app_version, event, call_ref, metadata, occurred_at)
       SELECT $1::uuid, $2, e.event, e.call_ref, e.metadata, e.occurred_at
         FROM jsonb_to_recordset($3::jsonb) AS e(event text, call_ref text, metadata jsonb, occurred_at timestamptz)`,
      [staff, "1.0", JSON.stringify([{ event: "answer_tapped", call_ref: leg, metadata: { ms: "5" }, occurred_at: new Date().toISOString() }])],
    );
    const r = await pool.query("SELECT event, call_ref, metadata FROM dialer_client_events WHERE user_id = $1", [staff]);
    expect(r.rows).toEqual([{ event: "answer_tapped", call_ref: leg, metadata: { ms: "5" } }]);
  });
});
