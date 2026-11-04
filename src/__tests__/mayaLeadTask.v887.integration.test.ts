// BF_SERVER_v887_MAYA_LEAD_TASK - the call-back task for a Maya website lead, against the real tasks table
// (its CHECK constraints on type, priority, source and silo).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { createMayaLeadFollowUp } from "../leads/mayaLeadFollowUp.js";

const tag = randomUUID().slice(0, 8);
const OWNER = randomUUID();
const CONTACT = randomUUID();
const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

describe("Maya lead follow-up task (real Postgres, v887)", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO users (id, email, active, is_active, status, role, first_name, last_name, silo, silos)
       VALUES ($1, $2, true, true, 'ACTIVE', 'Staff', 'Quinn', 'V887', 'BF', ARRAY['BF'])`,
      [OWNER, `quinn-${tag}@example.com`],
    );
    await pool.query(`INSERT INTO contacts (id, name, email, owner_id, silo) VALUES ($1, $2, $3, $4, 'BF')`,
      [CONTACT, `Casey ${tag}`, `casey-${tag}@example.com`, OWNER]);
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params as any[]).catch((e) => console.warn("cleanup", String(e)));
    await clean(`DELETE FROM tasks WHERE contact_id = $1::uuid`, [CONTACT]);
    await clean(`DELETE FROM contacts WHERE id = $1::uuid`, [CONTACT]);
    await clean(`DELETE FROM users WHERE id = $1::uuid`, [OWNER]);
  });

  it("creates one CALL task for the contact owner, and not a second within 24 hours", async () => {
    const first = await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: `Casey ${tag}`, isNewContact: false, message: "Looking for a line of credit" });
    expect(first).toMatchObject({ created: true, assigneeUserId: OWNER });
    const rows = (await pool.query(
      `SELECT title, type, priority, source, status, assignee_user_id::text AS assignee, due_at > now() - interval '1 minute' AS due_ok
         FROM tasks WHERE contact_id = $1::uuid`, [CONTACT])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: `Call back Casey ${tag}: website chat lead`, type: "CALL", priority: "HIGH", source: "API", status: "NOT_STARTED", assignee: OWNER, due_ok: true });

    const second = await createMayaLeadFollowUp(db, { contactId: CONTACT, silo: "BF", name: `Casey ${tag}`, isNewContact: false });
    expect(second).toEqual({ created: false, reason: "open_task_exists" });
    expect((await pool.query(`SELECT count(*)::int AS n FROM tasks WHERE contact_id = $1::uuid`, [CONTACT])).rows[0].n).toBe(1);
  });
});
