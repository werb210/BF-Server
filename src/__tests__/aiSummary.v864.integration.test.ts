// BF_SERVER_v864_AI_SUMMARY_FIX - the summary's record query against real Postgres (baseline + migrations). Before
// the fix it failed for every contact: visitor_sessions.contact_id is text and was compared with the uuid c.id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { generateSummary } from "../modules/crmUnify/aiSummary.js";

const contact = randomUUID();

describe("v864 AI summary on a contact (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO contacts (id, name, email, silo) VALUES ($1, 'Walter Test', $2, 'BF')`, [contact, `walter-${contact.slice(0, 8)}@gmail.com`]);
    await pool.query(`INSERT INTO visitor_sessions (session_id, contact_id) VALUES ($1, $2::text)`, [`v864-${contact}`, contact]);
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM crm_ai_summaries WHERE entity_id = $1`, [contact]);
    await pool.query(`DELETE FROM visitor_sessions WHERE contact_id = $1`, [contact]);
    await pool.query(`DELETE FROM contacts WHERE id = $1`, [contact]);
  });

  it("reads the record, counts its visits and saves the summary", async () => {
    const out = await generateSummary(pool as any, { brief: async () => "Walter has no communications yet.", background: async () => null }, "BF", "contact", contact, null);
    expect(out?.summary).toBe("Walter has no communications yet.");
    expect(out?.sources.find((x) => x.type === "visits")?.detail).toBe("1");
    const saved = await pool.query(`SELECT summary FROM crm_ai_summaries WHERE entity_id = $1 AND silo = 'BF'`, [contact]);
    expect(saved.rows[0]?.summary).toBe("Walter has no communications yet.");
  });
});
