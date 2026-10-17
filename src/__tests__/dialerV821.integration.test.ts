// BF_SERVER_v821_DIALER - the v821 SQL against the real schema (baseline + migrations): caller card, call records +
// leg status + the summary lookup, next follow-up, missed summary and call hours. Mocked unit tests cannot catch a
// column that does not exist; this does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { pool } from "../db.js";
import { callerCardFor } from "../voice/callerCard.js";
import { closeCallRecord, inboundRecordName, openCallRecord, recordLegStatus } from "../voice/recordedDial.js";
import { dialerCallSummary } from "../services/calls/autoCallSummary.js";
import { awayStatus, identitiesOutsideHours, loadCallHours, saveCallHours } from "../voice/callHours.js";
import { mountRouter, staffToken } from "./helpers/staffRouterApp.js";

const staff = randomUUID();
const other = randomUUID();
const contact = randomUUID();
const appId = randomUUID();
const tag = "v821" + Math.floor(Math.random() * 1e6);
const phone = `+140355501${String(10 + Math.floor(Math.random() * 90))}`; // a reserved 403-555-01xx number
const parentSid = "CA" + randomUUID().replace(/-/g, "");
const legSid = "CA" + randomUUID().replace(/-/g, "");
const vmId = randomUUID();
const msgId = randomUUID();

describe("v821 dialler SQL against the real schema", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users (id, email, active, role, first_name) VALUES ($1, $2, true, 'Staff', 'Pat'), ($3, $4, true, 'Staff', 'Sam')",
      [staff, `${tag}-a@example.test`, other, `${tag}-b@example.test`]);
    await pool.query("INSERT INTO staff_presence (user_id, twilio_identity, status) VALUES ($1, $2, 'available')", [staff, staff]);
    await pool.query(
      "INSERT INTO contacts (id, name, phone, silo, company_name, tags) VALUES ($1, $2, $3, 'BF', 'Client Trucking Ltd', ARRAY['vip'])",
      [contact, `Jane ${tag}`, phone]);
    await pool.query(
      "INSERT INTO applications (id, name, created_at, updated_at, contact_id, pipeline_state, status) VALUES ($1, 'Client Trucking', now(), now(), $2, 'In Review', 'IN_REVIEW')",
      [appId, contact]);
    await pool.query("INSERT INTO crm_notes (body, contact_id, silo) VALUES ('Wants a callback about the equipment quote', $1, 'BF')", [contact]);
    await pool.query(
      "INSERT INTO tasks (silo, title, assignee_user_id, contact_id, due_at, type) VALUES ('BF', $1, $2, $3, now() - interval '1 day', 'CALL')",
      [`Call ${tag}`, staff, contact]);
    await pool.query("INSERT INTO call_logs (twilio_call_sid, from_number, direction, status, silo) VALUES ($1, $2, 'inbound', 'no-answer', 'BF')", [parentSid, phone]);
    await pool.query(
      "INSERT INTO notifications (user_id, type, title, body, ref_table, ref_id) VALUES ($1, 'call_missed', 'Missed call', $2, 'calls', $3)",
      [staff, `Missed call from Jane ${tag}`, parentSid]);
    await pool.query(
      "INSERT INTO communications_messages (id, type, direction, contact_id, body, silo, from_number) VALUES ($1, 'sms', 'inbound', $2, 'Can you call me?', 'BF', $3)",
      [msgId, contact, phone]);
    await pool.query(
      "INSERT INTO voicemails (id, call_sid, recording_sid, recording_url, from_number, contact_id, staff_user_id, transcript, silo) VALUES ($1, $2, $3, 'https://example.test/r', $4, $5, $6, 'Please call me back', 'BF')",
      [vmId, parentSid, "RE" + tag, phone, contact, staff]);
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM conference_participants WHERE conference_id IN (SELECT id FROM conferences WHERE friendly_name = $1)", [inboundRecordName(parentSid)]);
    await clean("DELETE FROM call_transcripts WHERE conference_id IN (SELECT id FROM conferences WHERE friendly_name = $1)", [inboundRecordName(parentSid)]);
    await clean("DELETE FROM call_recordings WHERE conference_id IN (SELECT id FROM conferences WHERE friendly_name = $1)", [inboundRecordName(parentSid)]);
    await clean("DELETE FROM conferences WHERE friendly_name = $1", [inboundRecordName(parentSid)]);
    await clean("DELETE FROM voicemails WHERE id = $1", [vmId]);
    await clean("DELETE FROM communications_messages WHERE id = $1", [msgId]);
    await clean("DELETE FROM notifications WHERE user_id = $1", [staff]);
    await clean("DELETE FROM call_logs WHERE twilio_call_sid = $1", [parentSid]);
    await clean("DELETE FROM tasks WHERE assignee_user_id = $1", [staff]);
    await clean("DELETE FROM crm_notes WHERE contact_id = $1", [contact]);
    await clean("DELETE FROM applications WHERE id = $1", [appId]);
    await clean("DELETE FROM contacts WHERE id = $1", [contact]);
    await clean("DELETE FROM staff_call_hours WHERE user_id = ANY($1::uuid[])", [[staff, other]]);
    await clean("DELETE FROM staff_presence WHERE user_id = $1", [staff]);
    await clean("DELETE FROM users WHERE id = ANY($1::uuid[])", [[staff, other]]);
  });

  it("caller card", async () => {
    const card = await callerCardFor(pool, phone, "BF");
    expect(card).toMatchObject({
      found: true, contactId: contact, name: `Jane ${tag}`, company: "Client Trucking Ltd", stage: "In Review", applicationId: appId,
      lastNote: "Wants a callback about the equipment quote", tags: ["vip"],
    });
    expect(card.lastContactAt).toBeTruthy();
    expect(await callerCardFor(pool, phone, "BI")).toEqual({ found: false });
  });

  it("call record -> answered leg -> summary lookup, with the access rule", async () => {
    const rec = await openCallRecord(pool, {
      friendlyName: inboundRecordName(parentSid), direction: "inbound", contactId: contact,
      participants: [{ kind: "pstn", phone, callSid: parentSid }],
    });
    expect(rec).toBe(inboundRecordName(parentSid));
    expect(await openCallRecord(pool, { friendlyName: rec!, direction: "inbound" })).toBe(rec); // idempotent
    expect((await pool.query("SELECT count(*)::int AS n FROM conferences WHERE friendly_name = $1", [rec])).rows[0].n).toBe(1);

    await recordLegStatus(pool, { friendlyName: rec!, identity: staff, callSid: legSid, status: "in-progress" });
    const conf = (await pool.query("SELECT id, status FROM conferences WHERE friendly_name = $1", [rec])).rows[0];
    expect(conf.status).toBe("answered");

    expect((await dialerCallSummary(legSid, { userId: staff, isAdmin: false })).body).toMatchObject({ status: "pending", contactId: contact, contactName: `Jane ${tag}` });
    expect((await dialerCallSummary(legSid, { userId: other, isAdmin: false })).access).toBe("forbidden");
    expect((await dialerCallSummary(parentSid, { userId: other, isAdmin: true })).access).toBe("ok");

    await pool.query("INSERT INTO call_recordings (conference_id, twilio_recording_sid, status) VALUES ($1, $2, 'completed')", [conf.id, "RE" + legSid]);
    await pool.query(
      "INSERT INTO call_transcripts (conference_id, status, full_text, voice_intelligence_summary, suggested_tasks) VALUES ($1, 'completed', 'x', $2, $3::jsonb)",
      [conf.id, "- Wants a quote\nFollow-ups: send statements", JSON.stringify([{ title: "Send statements", type: "EMAIL", dueInDays: 1 }])]);
    expect((await dialerCallSummary(legSid, { userId: staff, isAdmin: false })).body).toEqual({
      status: "ready", summary: "- Wants a quote\nFollow-ups: send statements", nextSteps: ["Send statements"], contactId: contact, contactName: `Jane ${tag}`,
    });

    await recordLegStatus(pool, { friendlyName: rec!, identity: staff, callSid: legSid, status: "completed" });
    await closeCallRecord(pool, rec!);
    expect((await pool.query("SELECT status FROM conferences WHERE friendly_name = $1", [rec])).rows[0].status).toBe("ended");
    // never 'joined': presence's on_call sync must not count a call record
    expect((await pool.query("SELECT status FROM conference_participants WHERE twilio_call_sid = $1", [legSid])).rows[0].status).toBe("left");
  });

  it("next follow-up and missed summary routes", async () => {
    const { nextFollowUpRouter, missedSummaryRouter } = await import("../routes/staffDialer.js");
    const next = await request(mountRouter(nextFollowUpRouter, "/n")).get("/n").set("Authorization", `Bearer ${staffToken("Staff", staff)}`);
    expect(next.status).toBe(200);
    expect(next.body).toMatchObject({ found: true, title: `Call ${tag}`, contactId: contact, contactName: `Jane ${tag}`, phone });

    const missed = await request(mountRouter(missedSummaryRouter, "/m")).get("/m").set("Authorization", `Bearer ${staffToken("Staff", staff)}`);
    expect(missed.status).toBe(200);
    expect(missed.body.missedCalls[0]).toMatchObject({ name: `Jane ${tag}`, phone });
    expect(missed.body.unreadMessages.find((m: any) => m.contactId === contact)).toMatchObject({ preview: "Can you call me?", kind: "sms" });
    expect(missed.body.voicemails.find((v: any) => v.excerpt === "Please call me back")).toMatchObject({ name: `Jane ${tag}`, phone });
  });

  it("call hours round-trip and the away checks", async () => {
    expect(await loadCallHours(pool, staff)).toMatchObject({ enabled: false, updatedAt: null });
    const saved = await saveCallHours(pool, staff, {
      enabled: true, timezone: "America/Vancouver", urgentPassthrough: false,
      weekly: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
    });
    expect(saved).toMatchObject({ enabled: true, timezone: "America/Vancouver", urgentPassthrough: false });
    expect(await awayStatus(pool, staff)).toEqual({ away: true, urgentPassthrough: false });
    expect([...(await identitiesOutsideHours(pool, [staff]))]).toEqual([staff]);
    expect(await awayStatus(pool, other)).toEqual({ away: false, urgentPassthrough: true });
  });
});
