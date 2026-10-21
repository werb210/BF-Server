// BF_SERVER_v838_SIGNIN_SKIPS_UNSUBMITTED - sign-in opens the client portal only for applications that were sent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { UNSUBMITTED_CLIENT_DRAFT_EXCLUSION } from "../routes/client/signInDraftFilter.js";

const contact = randomUUID();
const started = randomUUID();
const sent = randomUUID();
const staffMade = randomUUID();
const digits = "587" + String(Math.floor(1e6 + Math.random() * 8e6));

describe("v838 sign-in skips applications the client never submitted", () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO contacts (id, first_name, last_name, phone, silo, created_at, updated_at)
       VALUES ($1, 'Unknown', '(application started)', $2, 'BF', now(), now())`,
      [contact, "+1" + digits],
    );
    const add = (id: string, source: string, submitted: boolean) => pool.query(
      `INSERT INTO applications (id, name, metadata, pipeline_state, status, source, contact_id, submitted_at, created_at, updated_at)
       VALUES ($1, 'Draft application', '{}'::jsonb, 'Received', 'RECEIVED', $2, $3, ${submitted ? "now()" : "NULL"}, now(), now())`,
      [id, source, contact],
    );
    await add(started, "client_direct", false);
    await add(sent, "client_direct", true);
    await add(staffMade, "staff_portal", false);
  });
  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM applications WHERE id::text = ANY($1::text[])", [[started, sent, staffMade]]);
    await clean("DELETE FROM contacts WHERE id = $1", [contact]);
  });

  it("leaves out the unfinished one and keeps the sent and staff-made ones", async () => {
    const r = await pool.query(
      `SELECT a.id::text AS id FROM applications a JOIN contacts c ON c.id = a.contact_id
        WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
          AND a.pipeline_state NOT IN ('draft','Draft','') AND a.pipeline_state IS NOT NULL
          ${UNSUBMITTED_CLIENT_DRAFT_EXCLUSION}`,
      [digits],
    );
    const ids = r.rows.map((row) => row.id).sort();
    expect(ids).toEqual([sent, staffMade].sort());
  });

});
