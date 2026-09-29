// BF_SERVER_TEAM_PHASE_C_v671 - cards, automatic posts, save / remind and @Maya against a real database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createApp } from "../app.js";
import { pool } from "../db.js";
import { deps } from "../system/deps.js";
import { extractCardRefs, mentionsMaya, postTeamAlert, runDueReminders } from "../services/team/teamPhaseC.js";

const SECRET = process.env.JWT_SECRET || "ci-integration-secret-min-10";
const me = randomUUID();
const tok = "Bearer " + jwt.sign({ id: me, sub: me, role: "Admin" }, SECRET, { algorithm: "HS256" });
const tag = "v671" + Math.floor(Math.random() * 1e6);
const made: string[] = [];

describe("v671 team phase C", () => {
  const app = createApp();
  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    for (const f of ["2026_09_28_v643_team_prefs.sql", "2026_09_28_v658_team_phase_b.sql", "2026_09_28_v671_team_phase_c.sql"]) {
      await pool.query(readFileSync("migrations/" + f, "utf8"));
    }
  });
  beforeEach(() => { deps.db.ready = true; (deps.db as any).client = pool; });
  afterAll(async () => {
    vi.unstubAllGlobals();
    if (made.length) await pool.query("DELETE FROM team_channels WHERE id = ANY($1::uuid[])", [made]).catch(() => undefined);
  });

  it("finds contact and application links and @Maya", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(extractCardRefs("see https://staff.boreal.financial/crm/contacts/" + id + " and /applications/" + id + " and /crm/contacts/" + id))
      .toEqual([{ kind: "contact", id }, { kind: "application", id }]);
    expect(mentionsMaya("hey @Maya how are we doing")).toBe(true);
    expect(mentionsMaya("email@maya.com")).toBe(false);
  });

  it("posts alerts as Boreal into a channel it creates, and returns cards for linked records", async () => {
    const name = "alerts-" + tag;
    expect(await postTeamAlert("#" + name, "Missed call from +14035550100")).toBe(true);
    const ch = await pool.query("SELECT id FROM team_channels WHERE name = $1", [name]);
    made.push(ch.rows[0].id);
    const msg = await pool.query("SELECT sender_id, bot, body FROM team_messages WHERE channel_id = $1", [ch.rows[0].id]);
    expect(msg.rows[0]).toMatchObject({ sender_id: null, bot: "Boreal", body: "Missed call from +14035550100" });
    const contact = await pool.query("INSERT INTO contacts (name, phone, silo) VALUES ($1, '+14035550199', 'BF') RETURNING id::text AS id", ["Card " + tag]);
    const cards = await request(app).get("/api/team/cards?ids=contact:" + contact.rows[0].id).set("Authorization", tok);
    expect(cards.status).toBe(200);
    expect(cards.body.cards[0]).toMatchObject({ kind: "contact", title: "Card " + tag, url: "/crm/contacts/" + contact.rows[0].id });
    await pool.query("DELETE FROM contacts WHERE id = $1", [contact.rows[0].id]);
  });

  it("saves a message, lists it, and sends the reminder once it is due", async () => {
    const c = await request(app).post("/api/team/channels").set("Authorization", tok).send({ kind: "channel", name: "saved-" + tag });
    const channelId = c.body.channel_id; made.push(channelId);
    const m = await request(app).post(`/api/team/channels/${channelId}/messages`).set("Authorization", tok).send({ body: "Call Accord back " + tag });
    const messageId = m.body.message.id;
    expect((await request(app).post(`/api/team/messages/${messageId}/save`).set("Authorization", tok).send({ remind_at: new Date(Date.now() - 1000).toISOString() })).status).toBe(200);
    expect((await request(app).post(`/api/team/messages/${randomUUID()}/save`).set("Authorization", tok).send({})).status).toBe(404);
    const list = await request(app).get("/api/team/saved").set("Authorization", tok);
    expect(list.body.saved.find((s: any) => s.message_id === messageId)).toMatchObject({ body: "Call Accord back " + tag, reminded_at: null });
    expect(await runDueReminders()).toBeGreaterThanOrEqual(1);
    const after = await request(app).get("/api/team/saved").set("Authorization", tok);
    expect(after.body.saved.find((s: any) => s.message_id === messageId).reminded_at).toBeTruthy();
    expect((await request(app).delete(`/api/team/messages/${messageId}/save`).set("Authorization", tok)).body.removed).toBe(true);
  });

  it("@Maya replies in the message's thread as Maya", async () => {
    process.env.MAYA_URL = "http://maya.test";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "Three deals are waiting on documents." }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = await request(app).post("/api/team/channels").set("Authorization", tok).send({ kind: "channel", name: "maya-" + tag });
    const channelId = c.body.channel_id; made.push(channelId);
    const m = await request(app).post(`/api/team/channels/${channelId}/messages`).set("Authorization", tok).send({ body: "@Maya what is waiting on documents?" });
    let replies: any[] = [];
    for (let i = 0; i < 40 && !replies.length; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      replies = (await pool.query("SELECT bot, body FROM team_messages WHERE thread_root_id = $1", [m.body.message.id])).rows;
    }
    expect(replies[0]).toMatchObject({ bot: "Maya", body: "Three deals are waiting on documents." });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("http://maya.test/api/maya/message");
    expect(init.headers["X-Maya-Audience"]).toBe("staff");
    expect(JSON.parse(init.body).message).toBe("what is waiting on documents?");
    const channelMsgs = await request(app).get(`/api/team/channels/${channelId}/messages`).set("Authorization", tok);
    expect(channelMsgs.body.messages).toHaveLength(1);
    expect(channelMsgs.body.messages[0].thread).toMatchObject({ reply_count: 1 });
    delete process.env.MAYA_URL;
  });
});
