// BF_SERVER_v830_DIALER_CONTROLS - the multi-party SQL against the real schema.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { endIfAlone, prepareMultiParty } from "../voice/multiParty.js";

const conf = randomUUID();
const tag = "v830" + Math.floor(Math.random() * 1e6);
const fake = () => {
  const calls: string[] = [];
  return { calls, tw: async () => ({ conferences: (sid: string) => ({
    update: async () => { calls.push(`end:${sid}`); return {}; },
    participants: (callSid: string) => ({ update: async () => { calls.push(`stay:${callSid}`); return {}; } }),
  }) }) as any };
};

describe("v830 multi-party calls against the real schema", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO conferences (id, friendly_name, direction, status, twilio_conference_sid) VALUES ($1, $2, 'outbound', 'active', 'CF${tag}')`, [conf, `mp_${tag}`]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, role, status, twilio_call_sid) VALUES ($1, 'staff', 'moderator', 'joined', 'CA-s-${tag}'), ($1, 'pstn', 'participant', 'joined', 'CA-c-${tag}')`, [conf]);
  });
  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM conference_participants WHERE conference_id = $1", [conf]);
    await clean("DELETE FROM conferences WHERE id = $1", [conf]);
  });

  it("marks the call multi-party and keeps both legs; ends it only when one is left", async () => {
    const a = fake();
    expect(await endIfAlone(conf, { twilio: a.tw })).toBe(false); // not multi-party yet
    expect(await prepareMultiParty(conf, { twilio: a.tw })).toBe(2);
    expect(a.calls.sort()).toEqual([`stay:CA-c-${tag}`, `stay:CA-s-${tag}`]);
    await pool.query(`INSERT INTO conference_participants (conference_id, kind, role, status) VALUES ($1, 'pstn', 'participant', 'ringing')`, [conf]);
    await pool.query(`UPDATE conference_participants SET status = 'left' WHERE twilio_call_sid = $1`, [`CA-s-${tag}`]);
    const b = fake();
    expect(await endIfAlone(conf, { twilio: b.tw })).toBe(false); // someone is still being rung
    await pool.query(`UPDATE conference_participants SET status = 'busy' WHERE conference_id = $1 AND status = 'ringing'`, [conf]);
    expect(await endIfAlone(conf, { twilio: b.tw })).toBe(true);
    expect(b.calls).toEqual([`end:CF${tag}`]);
  });
});
