// BF_SERVER_TEAM_PREFS_v643 - mute, mark unread and status against a real database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const me = randomUUID();
const other = randomUUID();
const tok = (id: string) => "Bearer " + jwt.sign({ id, sub: id, role: "Admin" }, SECRET, { algorithm: "HS256" });
let channelId = "";
let firstMsg = "";

describe("v643 team mute / unread / status", () => {
  const app = createApp();
  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    await pool.query(readFileSync("migrations/2026_09_28_v643_team_prefs.sql", "utf8"));
    const c = await pool.query("INSERT INTO team_channels (kind, name, created_by) VALUES ('channel', 'v643-test', $1) RETURNING id", [me]);
    channelId = c.rows[0].id;
    await pool.query("INSERT INTO team_channel_members (channel_id, user_id, last_read_at) VALUES ($1, $2, now()), ($1, $3, now())", [channelId, me, other]);
    const m = await pool.query("INSERT INTO team_messages (channel_id, sender_id, body, created_at) VALUES ($1, $2, 'first', now() - interval '2 minutes') RETURNING id", [channelId, other]);
    firstMsg = m.rows[0].id;
    await pool.query("INSERT INTO team_messages (channel_id, sender_id, body, created_at) VALUES ($1, $2, 'second', now() - interval '1 minute')", [channelId, other]);
  });
  // A background readiness probe can flip this during the run; the app itself is fine.
  beforeEach(() => { deps.db.ready = true; (deps.db as any).client = pool; });
  afterAll(async () => {
    await pool.query("DELETE FROM team_channels WHERE id = $1", [channelId]).catch(() => undefined);
    await pool.query("DELETE FROM team_user_status WHERE user_id = ANY($1::uuid[])", [[me, other]]).catch(() => undefined);
  });

  const mine = async () => {
    const r = await request(app).get("/api/team/channels").set("Authorization", tok(me));
    expect(r.status).toBe(200);
    return (r.body.channels ?? []).find((c: any) => c.id === channelId);
  };

  it("mute shows on the channel list and can be undone", async () => {
    expect((await mine()).muted).toBe(false);
    expect((await request(app).post("/api/team/channels/" + channelId + "/mute").set("Authorization", tok(me)).send({ muted: true })).status).toBe(200);
    expect((await mine()).muted).toBe(true);
    await request(app).post("/api/team/channels/" + channelId + "/mute").set("Authorization", tok(me)).send({ muted: false });
    expect((await mine()).muted).toBe(false);
  });

  it("mark unread from a message makes it and everything after unread", async () => {
    expect((await mine()).unread_count).toBe(0);
    const r = await request(app).post("/api/team/channels/" + channelId + "/unread").set("Authorization", tok(me)).send({ message_id: firstMsg });
    expect(r.status).toBe(200);
    expect((await mine()).unread_count).toBe(2);
  });

  it("status: custom text, Do Not Disturb, away - visible to everyone; expired text disappears", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const put = await request(app).put("/api/team/status").set("Authorization", tok(me))
      .send({ status_text: "At lender meeting", status_emoji: "🏦", status_until: until, dnd_until: until });
    expect(put.status).toBe(200);
    await request(app).put("/api/team/status").set("Authorization", tok(me)).send({ away: true });
    const all = await request(app).get("/api/team/statuses").set("Authorization", tok(other));
    const s = all.body.statuses.find((x: any) => x.user_id === me);
    expect(s).toMatchObject({ status_text: "At lender meeting", status_emoji: "🏦", dnd: true, away: true });
    await pool.query("UPDATE team_user_status SET status_until = now() - interval '1 minute', dnd_until = now() - interval '1 minute' WHERE user_id = $1", [me]);
    const later = (await request(app).get("/api/team/statuses").set("Authorization", tok(other))).body.statuses.find((x: any) => x.user_id === me);
    expect(later).toMatchObject({ status_text: null, dnd: false });
  });

  it("rejects a bad time", async () => {
    expect((await request(app).put("/api/team/status").set("Authorization", tok(me)).send({ dnd_until: "tomorrow-ish" })).status).toBe(400);
  });
});
