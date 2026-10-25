// BF_SERVER_v855_RETENTION - the retention migration, views, triggers, legal holds and generated package dates
// against real Postgres.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { applicationRetention, documentRetention, contactRetention, placeHold, releaseHold, retentionReport } from "../retention/retention.js";

const MIGRATION = "migrations/2026_10_24_v855_retention.sql";
const APP_OPEN = "e1400000-0000-4000-8000-000000000001";
const APP_CLOSED = "e1400000-0000-4000-8000-000000000002";
const APP_OLD = "e1400000-0000-4000-8000-000000000003";
const APP_DRAFT = "e1400000-0000-4000-8000-000000000004";
const DOC = "e1400000-0000-4000-8000-0000000000d1";
const CONTACT = "e1400000-0000-4000-8000-0000000000c1";
const APPS = [APP_OPEN, APP_CLOSED, APP_OLD, APP_DRAFT];
const ADMIN = { user: { name: "Integration Admin" } }; // no users row needed: actor_user_id stays null

async function cleanup() {
  await pool.query(`DELETE FROM application_packages WHERE application_id = ANY($1::text[])`, [APPS]);
  await pool.query(`DELETE FROM documents WHERE application_id = ANY($1::text[])`, [APPS]);
  await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [APPS]);
  await pool.query(`DELETE FROM contacts WHERE id = $1::uuid`, [CONTACT]);
  // Test rows only: the no-delete triggers are switched off for this cleanup and straight back on.
  await pool.query(`BEGIN; ALTER TABLE legal_holds DISABLE TRIGGER ks_legal_holds_no_delete;
    DELETE FROM legal_holds WHERE target_id = ANY(ARRAY['${APP_OPEN}','${APP_OLD}','${CONTACT}']);
    ALTER TABLE legal_holds ENABLE TRIGGER ks_legal_holds_no_delete;
    ALTER TABLE audit_events DISABLE TRIGGER ks_audit_events_retention;
    DELETE FROM audit_events WHERE target_id = ANY(ARRAY['${APP_OPEN}','${APP_OLD}','${CONTACT}','${DOC}']);
    ALTER TABLE audit_events ENABLE TRIGGER ks_audit_events_retention; COMMIT;`);
}

describe("BF v855 retention and legal holds (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    await cleanup();
    await pool.query(`INSERT INTO contacts (id, name) VALUES ($1, 'Retention Contact')`, [CONTACT]);
    const ins = `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, submitted_at, contact_id)
                 VALUES ($1, $2, $3, now(), $4, $5, $6, $7)`;
    await pool.query(ins, [APP_OPEN, "Open Co", new Date(), "Received", "RECEIVED", new Date(), CONTACT]);
    await pool.query(ins, [APP_CLOSED, "Closed Co", new Date(), "Received", "RECEIVED", new Date(), null]);
    await pool.query(ins, [APP_OLD, "Old Co", new Date(Date.now() - 10 * 365 * 86_400_000), "Rejected", "DECLINED", new Date(Date.now() - 10 * 365 * 86_400_000), null]);
    await pool.query(ins, [APP_DRAFT, "", new Date(), "Received", "RECEIVED", null, null]);
    await pool.query(`INSERT INTO documents (id, application_id, created_at, blob_name) VALUES ($1, $2, now(), 'applications/x/doc.pdf')`, [DOC, APP_CLOSED]);
  });

  afterAll(async () => {
    await cleanup().catch((e) => console.warn("cleanup", String(e)));
  });

  it("stamps closed_at when a file closes, and clears it if reopened", async () => {
    expect((await pool.query(`SELECT closed_at FROM applications WHERE id = $1`, [APP_CLOSED])).rows[0].closed_at).toBeNull();
    await pool.query(`UPDATE applications SET pipeline_state = 'Accepted', status = 'ACCEPTED' WHERE id = $1`, [APP_CLOSED]);
    expect((await pool.query(`SELECT closed_at FROM applications WHERE id = $1`, [APP_CLOSED])).rows[0].closed_at).toBeInstanceOf(Date);
    await pool.query(`UPDATE applications SET pipeline_state = 'Hold' WHERE id = $1`, [APP_CLOSED]);
    expect((await pool.query(`SELECT closed_at FROM applications WHERE id = $1`, [APP_CLOSED])).rows[0].closed_at).toBeNull();
    await pool.query(`UPDATE applications SET pipeline_state = 'Accepted' WHERE id = $1`, [APP_CLOSED]);
    // the old file: pretend it closed 9 years ago
    await pool.query(`UPDATE applications SET closed_at = now() - interval '9 years' WHERE id = $1`, [APP_OLD]);
  });

  it("locks records by the 7-year rule; an empty draft is not a record", async () => {
    const closed = await applicationRetention(APP_CLOSED, pool as any);
    expect(closed).toMatchObject({ locked: true, reason: "retention", file_open: false });
    expect(Number(closed!.deletable_on!.slice(0, 4))).toBe(new Date().getUTCFullYear() + 7);
    expect(await documentRetention(DOC, pool as any)).toMatchObject({ locked: true, reason: "retention" });
    expect(await applicationRetention(APP_OPEN, pool as any)).toMatchObject({ locked: true, file_open: true, deletable_on: null });
    expect(await applicationRetention(APP_OLD, pool as any)).toMatchObject({ locked: false });
    expect(await applicationRetention(APP_DRAFT, pool as any)).toMatchObject({ locked: false });
    expect(await contactRetention(CONTACT, pool as any)).toMatchObject({ locked: true, file_open: true });
    const report = await retentionReport(pool as any);
    expect(report.eligible_applications.map((a) => a.application_id)).toContain(APP_OLD);
    expect(report.eligible_applications.map((a) => a.application_id)).not.toContain(APP_CLOSED);
  });

  it("a legal hold locks even an eligible file until released, and both are audited", async () => {
    const placed = await placeHold(ADMIN, "application", APP_OLD, "regulator request", pool as any);
    expect(placed.ok).toBe(true);
    expect(await applicationRetention(APP_OLD, pool as any)).toMatchObject({ locked: true, reason: "hold" });
    expect((await retentionReport(pool as any)).eligible_applications.map((a) => a.application_id)).not.toContain(APP_OLD);
    expect((await placeHold(ADMIN, "application", APP_OLD, "again", pool as any)).ok).toBe(false);
    const released = await releaseHold(ADMIN, (placed as any).hold.id, "closed", pool as any);
    expect(released.ok).toBe(true);
    expect(await applicationRetention(APP_OLD, pool as any)).toMatchObject({ locked: false });
    const audit = await pool.query(`SELECT event_type FROM audit_events WHERE target_id = $1 ORDER BY created_at`, [APP_OLD]);
    expect(audit.rows.map((r) => r.event_type)).toEqual(["legal_hold.placed", "legal_hold.released"]);
  });

  it("holds and young audit events cannot be deleted at the database", async () => {
    await expect(pool.query(`DELETE FROM legal_holds WHERE target_id = $1`, [APP_OLD])).rejects.toThrow(/permanent/);
    await expect(pool.query(`DELETE FROM audit_events WHERE target_id = $1`, [APP_OLD])).rejects.toThrow(/retention_locked/);
  });

  it("keeps a recently generated lender package even when its application closed over 7 years ago", async () => {
    await pool.query(`INSERT INTO application_packages (application_id, lender_id, created_at, built_at)
      VALUES ($1, gen_random_uuid(), now() - interval '1 day', now())`, [APP_OLD]);
    const s = await applicationRetention(APP_OLD, pool as any);
    expect(s).toMatchObject({ locked: true, reason: "retention" });
    expect(Number(s!.deletable_on!.slice(0, 4))).toBe(new Date().getUTCFullYear() + 7);
    expect((await retentionReport(pool as any)).eligible_applications.map((a) => a.application_id)).not.toContain(APP_OLD);
  });
});
