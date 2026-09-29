// BF_SERVER_TEAM_PHASE_B_v658 - channels, threads and search against a real database.
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
const outsider = randomUUID();
const tok = (id: string) => "Bearer " + jwt.sign({ id, sub: id, role: "Admin" }, SECRET, { algorithm: "HS256" });
const tag = "v658" + Math.floor(Math.random() * 1e6);
const made: string[] = [];

describe("v658 team channels, threads and search", () => {
  const app = createApp();
  beforeAll(async () => {
    deps.db.ready = true;
    (deps.db as any).client = pool;
    // Empty CI databases load the baseline snapshot, which predates these columns.
    await pool.query(readFileSync("migrations/2026_09_28_v643_team_prefs.sql", "utf8"));
    await pool.query(readFileSync("migrations/2026_09_28_v658_team_phase_b.sql", "utf8"));
    await pool.query(readFileSync("migrations/2026_09_28_v671_team_phase_c.sql", "utf8")); // BF_SERVER_TEAM_PHASE_C_v671
  });
  beforeEach(() => { deps.db.ready = true; (deps.db as any).client = pool; });
  afterAll(async () => {
    if (made.length) await pool.query("DELETE FROM team_channels WHERE id = ANY($1::uuid[])", [made]).catch(() => undefined);
  });
  const as = (id: string) => ({ get: (u: string) => request(app).get(u).set("Authorization", tok(id)), post: (u: string, b: object = {}) => request(app).post(u).set("Authorization", tok(id)).send(b), patch: (u: string, b: object) => request(app).patch(u).set("Authorization", tok(id)).send(b) });

  let pub = ""; let priv = ""; let root = "";

  it("creates #lowercase channels, refuses duplicates, and keeps private ones out of browse", async () => {
    const a = await as(me).post("/api/team/channels", { kind: "channel", name: "Deals " + tag, topic: "Live deals", member_ids: [other] });
    expect(a.status).toBe(200); pub = a.body.channel_id; made.push(pub);
    const dup = await as(me).post("/api/team/channels", { kind: "channel", name: "deals-" + tag });
    expect(dup.status).toBe(409);
    const b = await as(me).post("/api/team/channels", { kind: "channel", name: "secret-" + tag, is_private: true });
    priv = b.body.channel_id; made.push(priv);
    const browse = await as(outsider).get("/api/team/channels/browse");
    const names = browse.body.channels.map((c: any) => c.name);
    expect(names).toContain("deals-" + tag);
    expect(names).not.toContain("secret-" + tag);
    expect(browse.body.channels.find((c: any) => c.id === pub)).toMatchObject({ topic: "Live deals", is_member: false, member_count: 2 });
    expect(names).toContain("general");
  });

  it("joins public channels, not private ones; members can add people and edit the topic", async () => {
    expect((await as(outsider).post(`/api/team/channels/${priv}/join`)).status).toBe(403);
    expect((await as(outsider).post(`/api/team/channels/${pub}/join`)).status).toBe(200);
    expect((await as(me).post(`/api/team/channels/${priv}/members`, { member_ids: [outsider] })).status).toBe(200);
    const edit = await as(outsider).patch(`/api/team/channels/${pub}`, { topic: "Deals this week", name: "Deals Desk " + tag });
    expect(edit.status).toBe(200);
    expect(edit.body.channel).toMatchObject({ name: "deals-desk-" + tag, topic: "Deals this week" });
    const mine = await as(outsider).get("/api/team/channels");
    expect(mine.body.channels.map((c: any) => c.id)).toEqual(expect.arrayContaining([pub, priv]));
  });

  it("threads: replies stay out of the channel, show as a count on the root, and do not count as unread", async () => {
    const r = await as(other).post(`/api/team/channels/${pub}/messages`, { body: "Who can take the Accord file?" });
    root = r.body.message.id;
    await pool.query("UPDATE team_channel_members SET last_read_at = now() WHERE channel_id = $1", [pub]);
    const reply = await as(other).post(`/api/team/channels/${pub}/threads/${root}/messages`, { body: "I can, sending the quote " + tag });
    expect(reply.status).toBe(200);
    expect(reply.body.summary).toMatchObject({ reply_count: 1, participant_ids: [other] });
    await as(me).post(`/api/team/channels/${pub}/threads/${root}/messages`, { body: "Thanks", attachments: [{ name: "term-sheet-" + tag + ".pdf", contentType: "application/pdf", dataUrl: "data:application/pdf;base64,AA==" }] });
    const msgs = await as(me).get(`/api/team/channels/${pub}/messages`);
    expect(msgs.body.messages.map((m: any) => m.body)).toEqual(["Who can take the Accord file?"]);
    expect(msgs.body.messages[0].thread).toMatchObject({ reply_count: 2 });
    const thread = await as(me).get(`/api/team/channels/${pub}/threads/${root}`);
    expect(thread.body.root.id).toBe(root);
    expect(thread.body.replies.map((m: any) => m.body)).toEqual(["I can, sending the quote " + tag, "Thanks"]);
    const list = await as(outsider).get("/api/team/channels");
    expect(list.body.channels.find((c: any) => c.id === pub).unread_count).toBe(0);
    expect((await as(me).post(`/api/team/channels/${pub}/threads/${thread.body.replies[0].id}/messages`, { body: "nested" })).status).toBe(404);
  });

  it("search covers every conversation the person is in, including file names, and nothing else", async () => {
    const s = await as(me).get("/api/team/search?q=" + encodeURIComponent(tag));
    expect(s.body.messages.map((m: any) => m.body)).toEqual(expect.arrayContaining(["I can, sending the quote " + tag, "Thanks"]));
    expect(s.body.messages.find((m: any) => m.body === "Thanks").files).toEqual(["term-sheet-" + tag + ".pdf"]);
    expect(s.body.channels.map((c: any) => c.name)).toEqual(expect.arrayContaining(["deals-desk-" + tag, "secret-" + tag]));
    const stranger = await as(randomUUID()).get("/api/team/search?q=" + encodeURIComponent(tag));
    expect(stranger.body.messages).toEqual([]);
    expect(stranger.body.channels.map((c: any) => c.name)).toEqual(["deals-desk-" + tag]);
  });

  it("archived channels take no new messages or members; leaving works", async () => {
    expect((await as(me).post(`/api/team/channels/${pub}/archive`, { archived: true })).status).toBe(200);
    expect((await as(me).post(`/api/team/channels/${pub}/messages`, { body: "late" })).status).toBe(409);
    expect((await as(randomUUID()).post(`/api/team/channels/${pub}/join`)).status).toBe(409);
    expect((await as(me).post(`/api/team/channels/${pub}/archive`, { archived: false })).status).toBe(200);
    const left = await as(outsider).post(`/api/team/channels/${pub}/leave`);
    expect(left.body).toMatchObject({ ok: true, left: true });
    expect((await as(outsider).get(`/api/team/channels/${pub}/messages`)).status).toBe(403);
  });
});
