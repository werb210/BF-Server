// BF_SERVER_ENGAGEMENT_v1 - Keystone outreach tracking against real Postgres: flows -> stages -> follow-up -> owner ->
// task, a reply caught in any mailbox, a booking, sign-up from the trial tag, the queue, board and funnel.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { board, funnel, queue, reachedContactsByEmail, recordEvent, recordReply, syncEngagement, createFollowUpTasks, saveSettings } from "../engagement/engagement.js";

const MIGRATION = "migrations/2026_12_25_crm_engagement.sql";
const tag = `eng-${Date.now()}`;
let owner = "";
const ids: string[] = [];

async function contact(email: string, tags: string[] = []): Promise<string> {
  const r = await pool.query(
    `INSERT INTO contacts (id, name, email, silo, tags, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, 'KS', $3, now(), now()) RETURNING id`,
    [`${tag} ${email}`, email, tags]);
  ids.push(r.rows[0].id);
  return r.rows[0].id;
}

describe("Keystone engagement tracking", () => {
  let flowId = "";
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8"));
    const u = await pool.query(`SELECT id::text AS id FROM users LIMIT 1`);
    owner = u.rows[0]?.id ?? "";
    const f = await pool.query(
      `INSERT INTO crm_flows (silo, name, status, owner_user_id, owner_name) VALUES ('KS', $1, 'active', $2::uuid, 'Andrew') RETURNING id`,
      [`${tag} flow`, owner || null]);
    flowId = f.rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE contact_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM crm_engagement_events WHERE contact_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM crm_engagement WHERE contact_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM crm_flows WHERE id = $1`, [flowId]);
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM crm_engagement_settings WHERE silo = 'KS'`);
  });

  it("follows a broker from the first email to a trial", async () => {
    const sent = new Date(Date.now() - 3 * 86_400_000);
    const a = await contact(`a.${tag}@broker.test`);
    const b = await contact(`b.${tag}@broker.test`);
    for (const [id, email] of [[a, `a.${tag}@broker.test`], [b, `b.${tag}@broker.test`]]) {
      await pool.query(`INSERT INTO crm_flow_members (flow_id, contact_id, email, status, first_sent_at, opened_at, clicked_at) VALUES ($1, $2, $3, 'active', $4, $5, $5)`,
        [flowId, id, email, sent, new Date(sent.getTime() + 3_600_000)]);
    }
    await syncEngagement(pool);
    let q = await queue(pool, { silo: "KS" });
    expect(q.filter((x) => ids.includes(x.contact_id)).map((x) => x.follow_up_reason)).toEqual(["clicked", "clicked"]);
    if (owner) expect(q.find((x) => x.contact_id === a)?.owner_user_id).toBe(owner);

    expect((await reachedContactsByEmail(pool, `A.${tag}@broker.test`)).map((x) => x.id)).toEqual([a]);
    expect(await recordReply(pool, { contactId: a, at: new Date(), subject: "RE: Keystone", body: "Sounds interesting, let's set up a call" })).toBe("interested");
    expect(await recordReply(pool, { contactId: b, at: new Date(), subject: "RE: Keystone", body: "Please unsubscribe me" })).toBe("unsubscribe");
    await syncEngagement(pool);
    const titles: string[] = [];
    if (owner) {
      expect(await createFollowUpTasks(pool, async (_o, _s, title) => { titles.push(title); return { ok: true }; })).toBe(1);
      expect(titles[0]).toContain("Reply to");
    }
    expect(await recordEvent(pool, { contactId: a, kind: "booked", detail: { start: new Date(Date.now() + 86_400_000).toISOString() } })).toBe(true);
    expect(await recordEvent(pool, { contactId: a, kind: "met" })).toBe(true);
    await pool.query(`UPDATE contacts SET tags = ARRAY['ks_trial'], updated_at = now() WHERE id = $1`, [a]);
    await syncEngagement(pool);

    const st = await board(pool, { silo: "KS", flowId });
    expect(st.find((s) => s.key === "signed_up")?.count).toBe(1);
    expect(st.find((s) => s.key === "lost")?.count).toBe(1);
    expect(st.find((s) => s.key === "booked")?.label).toBe("Demo booked");
    q = await queue(pool, { silo: "KS" });
    expect(q.filter((x) => ids.includes(x.contact_id))).toEqual([]);
    const f = await funnel(pool, "KS");
    expect(f.byFlow.find((x: any) => x.flow_id === flowId)).toMatchObject({ sent: 2, replied: 2, booked: 1, met: 1, signed_up: 1, lost: 1 });
  });

  it("splits follow-ups between the follow-up people", async () => {
    const us = await pool.query(`SELECT id::text AS id FROM users LIMIT 2`);
    if (us.rows.length < 2) return;
    await saveSettings(pool, "KS", { followers: us.rows.map((r) => ({ id: r.id, name: "x" })) });
    const sent = new Date(Date.now() - 86_400_000);
    for (const n of [1, 2]) {
      const id = await contact(`rr${n}.${tag}@broker.test`);
      await pool.query(`INSERT INTO crm_flow_members (flow_id, contact_id, email, status, first_sent_at, clicked_at) VALUES ($1, $2, $3, 'active', $4, $4)`,
        [flowId, id, `rr${n}.${tag}@broker.test`, sent]);
    }
    await syncEngagement(pool);
    const r = await pool.query(`SELECT DISTINCT owner_user_id FROM crm_engagement e JOIN contacts c ON c.id = e.contact_id WHERE c.email LIKE 'rr%' AND c.name LIKE $1`, [`${tag}%`]);
    expect(r.rows.length).toBe(2);
  });
});
