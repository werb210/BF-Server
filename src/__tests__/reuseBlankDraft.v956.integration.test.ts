// BF_SERVER_v956_REUSE_BLANK_DRAFT - which application a returning client is handed back (real Postgres).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { REUSABLE_BLANK_DRAFT_SQL } from "../routes/publicApplication.js";

const contact = randomUUID(), other = randomUUID();
const ids: string[] = [];
async function app(fields: { contactId?: string; submitted?: boolean; source?: string; ageDays?: number; silo?: string; parent?: string | null }): Promise<string> {
  const id = randomUUID(); ids.push(id);
  await pool.query(
    `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, contact_id, source, silo, submitted_at, parent_application_id)
     VALUES ($1, 'Draft application', now() - ($2 || ' days')::interval, now(), 'Received', 'RECEIVED', $3, $4, $5, $6, $7)`,
    [id, String(fields.ageDays ?? 0), fields.contactId ?? contact, fields.source ?? "client_direct", fields.silo ?? "BF", fields.submitted ? new Date() : null, fields.parent ?? null],
  );
  return id;
}
const pick = async (c = contact, silo = "BF") => (await pool.query(REUSABLE_BLANK_DRAFT_SQL, [c, silo])).rows[0]?.id ?? null;

describe("a returning client gets their unsent application back", () => {
  beforeAll(async () => {
    for (const [id, phone] of [[contact, "+17805550191"], [other, "+17805550192"]]) {
      await pool.query(`INSERT INTO contacts (id, name, phone, silo) VALUES ($1, $2, $3, 'BF')`, [id, `Reuse ${id.slice(0, 8)}`, phone]);
    }
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM applications WHERE id::text = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM contacts WHERE id::text = ANY($1::text[])`, [[contact, other]]);
  });

  it("nothing to reuse when the client has no unsent application", async () => {
    await app({ submitted: true });
    await app({ source: "broker_import" });
    await app({ ageDays: 45 });
    await app({ silo: "BI" });
    await app({ contactId: other });
    expect(await pick()).toBeNull();
  });

  it("hands back the newest unsent one", async () => {
    const older = await app({ ageDays: 3 });
    const newer = await app({ ageDays: 1 });
    expect(await pick()).toBe(newer);
    expect(await pick()).not.toBe(older);
    expect(await pick(other)).not.toBe(newer);
  });
});
