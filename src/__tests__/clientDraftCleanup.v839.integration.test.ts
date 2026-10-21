// BF_SERVER_v839_CLIENT_DRAFT_CLEANUP - the client portal lists one unfinished application, and Remove takes it
// (and older unfinished ones) off the list without deleting anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { CLIENT_REMOVED_EXCLUSION, keepNewestUnfinished, removeUnfinishedDrafts } from "../routes/client/signInDraftFilter.js";

const contact = randomUUID();
const sent = randomUUID();
const older = randomUUID();
const newer = randomUUID();
const digits = "403" + String(Math.floor(1e6 + Math.random() * 8e6));

const listed = async () => {
  const r = await pool.query(
    `SELECT a.id::text AS id, a.submitted_at, a.source FROM applications a JOIN contacts c ON c.id = a.contact_id
      WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1 ${CLIENT_REMOVED_EXCLUSION}
      ORDER BY a.updated_at DESC`,
    [digits],
  );
  return keepNewestUnfinished(r.rows).map((row) => row.id);
};

describe("v839 client draft cleanup against the real schema", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contacts (id, first_name, last_name, phone, silo, created_at, updated_at)
       VALUES ($1, 'Unknown', '(application started)', $2, 'BF', now(), now())`,
      [contact, "+1" + digits],
    );
    const add = (id: string, submitted: boolean, daysAgo: number) => pool.query(
      `INSERT INTO applications (id, name, metadata, pipeline_state, status, source, contact_id, submitted_at, created_at, updated_at)
       VALUES ($1, 'Draft application', '{}'::jsonb, 'Received', 'RECEIVED', 'client_direct', $2, ${submitted ? "now()" : "NULL"},
               now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval)`,
      [id, contact, String(daysAgo)],
    );
    await add(sent, true, 10);
    await add(older, false, 5);
    await add(newer, false, 1);
  });
  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM applications WHERE id::text = ANY($1::text[])", [[sent, older, newer]]);
    await clean("DELETE FROM contacts WHERE id = $1", [contact]);
  });

  it("lists the sent application and only the newest unfinished one", async () => {
    expect(await listed()).toEqual([newer, sent]);
  });

  it("Remove takes the unfinished ones off the list, keeps the rows, and never touches a sent one", async () => {
    expect(await removeUnfinishedDrafts(pool, sent, digits)).toBeNull();
    expect(await removeUnfinishedDrafts(pool, newer, "9999999999")).toBeNull(); // someone else's phone
    expect(await removeUnfinishedDrafts(pool, newer, digits)).toBe(2);
    expect(await listed()).toEqual([sent]);
    const rows = await pool.query(`SELECT count(*)::int AS n FROM applications WHERE id::text = ANY($1::text[])`, [[sent, older, newer]]);
    expect(rows.rows[0].n).toBe(3);
  });
});
