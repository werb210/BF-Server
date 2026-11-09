// BF_SERVER_v923_SKIP_TEXTED - "Skip contacts who got a marketing text in the last 7 days" (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { countEmailRecipients, emailRecipients, skipTextedDaysOf } from "../services/marketingSendRunner.js";

const tag = `v923-${randomUUID().slice(0, 8)}`;
const texted = randomUUID(), oldText = randomUUID(), never = randomUUID(), failedText = randomUUID();
const ids = [texted, oldText, never, failedText];
const campaign = randomUUID();

describe("v923 skip contacts texted recently", () => {
  beforeAll(async () => {
    for (const id of ids) {
      await pool.query(`INSERT INTO contacts (id, name, email, silo, tags) VALUES ($1, $2, $3, 'BF', ARRAY[$4])`, [id, `T ${id.slice(0, 4)}`, `${id}@example.com`, tag]);
    }
    await pool.query(`INSERT INTO sms_campaigns (id, silo, sms_body) VALUES ($1, 'BF', 'v923 test')`, [campaign]); // the sends need a campaign
    const sms = `INSERT INTO sms_campaign_sends (campaign_id, contact_id, silo, phone, sent_at, message_sid) VALUES ($1, $2, 'BF', '+14035550100', now() - ($3::int * interval '1 day'), $4)`;
    await pool.query(sms, [campaign, texted, 2, "SM-test-1"]);
    await pool.query(sms, [campaign, oldText, 20, "SM-test-2"]);
    await pool.query(sms, [campaign, failedText, 1, null]); // never actually sent
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM sms_campaign_sends WHERE contact_id = ANY($1::uuid[])`, [ids]).catch((e) => console.warn("cleanup", String(e)));
    await pool.query(`DELETE FROM contacts WHERE id = ANY($1::uuid[])`, [ids]).catch((e) => console.warn("cleanup", String(e)));
    await pool.query(`DELETE FROM sms_campaigns WHERE id = $1`, [campaign]).catch((e) => console.warn("cleanup", String(e)));
  });

  it("counts everyone without the option, and leaves out the recently texted with it", async () => {
    expect(await countEmailRecipients(pool as any, "BF", null, [tag], null)).toBe(4);
    expect(await countEmailRecipients(pool as any, "BF", null, [tag], null, 7)).toBe(3);
  });
  it("the send list matches the count", async () => {
    const rows = await emailRecipients(pool as any, { silo: "BF", tag: null, subject: "s", html: "h", tags: [tag], skipTextedDays: 7 });
    expect(rows.map((r) => r.id).sort()).toEqual([oldText, never, failedText].sort());
  });
  it("reads the checkbox value", () => {
    expect(skipTextedDaysOf(true)).toBe(7);
    expect(skipTextedDaysOf("1")).toBe(7);
    expect(skipTextedDaysOf(14)).toBe(14);
    expect(skipTextedDaysOf(undefined)).toBeNull();
    expect(skipTextedDaysOf(false)).toBeNull();
  });
});
