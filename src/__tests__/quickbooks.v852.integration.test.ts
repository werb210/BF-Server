// BF_SERVER_v852_CALC_QBO - QuickBooks fee invoices against real Postgres (baseline + the v852 migration), with Intuit
// faked: the migration is idempotent, the outbox discovers a signed agreement, syncs it (invoice), records a failure
// with backoff, then follows funding to paid; tokens are stored encrypted and renewed with rotation.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { runFeeInvoiceTick, syncFeeInvoice, getInvoiceRow } from "../services/quickbooks/feeInvoices.js";
import { exchangeCodeAndConnect, accessToken, getConnection } from "../services/quickbooks/qboClient.js";
import { decryptToken } from "../services/quickbooks/qboCrypto.js";
import { QBO_ENV, fakeIntuit } from "../services/quickbooks/__tests__/qboFixtures.js";

const MIGRATION = "migrations/2026_10_23_v852_calc_qbo.sql";
const APP = randomUUID();
const OTHER = randomUUID();
const db = { query: (sql: string, params?: unknown[]) => pool.query(sql, params as any[]) };

describe("v852 QuickBooks fee invoices (real Postgres)", () => {
  beforeAll(async () => {
    await pool.query(readFileSync(MIGRATION, "utf8"));
    await pool.query(readFileSync(MIGRATION, "utf8")); // safe to run again
    await pool.query(`DELETE FROM qbo_connections`);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const id of [APP, OTHER]) {
      await pool.query(
        `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, source, silo, requested_amount, metadata)
         VALUES ($1, 'Northern Lights Films', now(), now(), 'Off to lender', 'RECEIVED', 'test', 'BF', 250000, $2::jsonb)`,
        [id, JSON.stringify({ business: { legalName: "Northern Lights Films Ltd." }, applicant: { email: "ada@client.example" } })],
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM qbo_fee_invoices WHERE application_id = ANY($1::text[])`, [[APP, OTHER]]);
    await pool.query(`DELETE FROM media_fee_agreements WHERE application_id = ANY($1::text[])`, [[APP, OTHER]]);
    await pool.query(`DELETE FROM applications WHERE id = ANY($1::text[])`, [[APP, OTHER]]);
    await pool.query(`DELETE FROM qbo_connections`);
    await pool.query(`DELETE FROM settings WHERE key LIKE 'quickbooks.%'`);
    vi.restoreAllMocks();
  });

  it("connects: tokens stored encrypted, renewed with the rotated refresh token", async () => {
    const intuit = fakeIntuit([(c) => (c.url.startsWith("https://oauth.platform.intuit.com/") && c.body?.grant_type === "authorization_code"
      ? { body: { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600, x_refresh_token_expires_in: 8640000 } } : undefined)]);
    await exchangeCodeAndConnect("the-code", "9341452", randomUUID(), { db, fetchImpl: intuit.fetchImpl as any, env: QBO_ENV });
    const conn = (await getConnection({ db }))!;
    expect(conn.realm_id).toBe("9341452");
    expect(conn.company_name).toBe("Boreal Sandbox Co");
    expect(conn.refresh_token_enc).not.toContain("ref-1");
    expect(decryptToken(conn.refresh_token_enc, QBO_ENV)).toBe("ref-1");
    // about to expire: the next use renews it and stores Intuit's new (rotated) refresh token
    await pool.query(`UPDATE qbo_connections SET access_expires_at = now() + interval '1 minute'`);
    const tok = await accessToken({ db, fetchImpl: intuit.fetchImpl as any, env: QBO_ENV });
    expect(tok.token).toBe("access-2");
    expect(decryptToken((await getConnection({ db }))!.refresh_token_enc, QBO_ENV)).toBe("refresh-2");
  });

  it("an agreement signed before QuickBooks was connected is not invoiced; one signed after is", async () => {
    await pool.query(`INSERT INTO media_fee_agreements (application_id, status, signed_at, signer_email) VALUES ($1, 'signed', now() - interval '30 days', 'old@client.example')`, [OTHER]);
    await pool.query(`INSERT INTO media_fee_agreements (application_id, status, signed_at, signer_email) VALUES ($1, 'signed', now() + interval '1 second', 'ada@client.example')`, [APP]);
    let failNext = true;
    const intuit = fakeIntuit([(c) => {
      if (c.method === "POST" && c.path.endsWith("/invoice") && failNext) { failNext = false; return { status: 503, body: { Fault: { Error: [{ Message: "Service unavailable" }] } } }; }
      return undefined;
    }]);
    const deps = { db, fetchImpl: intuit.fetchImpl as any, env: QBO_ENV };
    const first = await runFeeInvoiceTick(deps);
    expect(first.queued).toBe(1);
    expect(first.failed).toBe(1);
    expect(await getInvoiceRow(OTHER, { db })).toBeNull();
    const failed = (await pool.query(`SELECT sync_state, attempts, last_error, next_attempt_at > now() AS later, lease_until FROM qbo_fee_invoices WHERE application_id = $1`, [APP])).rows[0];
    expect(failed).toMatchObject({ sync_state: "failed", attempts: 1, later: true, lease_until: null });
    expect(failed.last_error).toMatch(/Service unavailable/);

    // not due yet: the tick leaves it; a Retry (sync now) creates the invoice
    expect((await runFeeInvoiceTick(deps)).synced).toBe(0);
    expect(await syncFeeInvoice(APP, deps)).toEqual({ ok: true, action: "invoice_created" });
    const row = (await getInvoiceRow(APP, { db }))!;
    expect(row).toMatchObject({ qbo_invoice_id: "130", doc_number: "1042", status: "open", sync_state: "ok", attempts: 0 });
    expect(Number(row.amount)).toBe(5000);
    expect((await pool.query(`SELECT value FROM settings WHERE key = 'quickbooks.fee_item'`)).rows[0].value).toBe("9341452:21");
  });

  it("funding re-queues the open invoice and it ends paid at the funded amount", async () => {
    await pool.query(`UPDATE applications SET funded_amount = 200000, funded_at = now(), pipeline_state = 'Accepted' WHERE id = $1`, [APP]);
    const intuit = fakeIntuit();
    const out = await runFeeInvoiceTick({ db, fetchImpl: intuit.fetchImpl as any, env: QBO_ENV });
    expect(out).toMatchObject({ queued: 1, synced: 1, failed: 0 });
    const row = (await getInvoiceRow(APP, { db }))!;
    expect(row).toMatchObject({ status: "paid", qbo_payment_id: "200", sync_state: "ok" });
    expect(Number(row.amount)).toBe(4000);
    // idempotent: nothing more to do, no more Intuit calls
    const again = fakeIntuit();
    expect(await runFeeInvoiceTick({ db, fetchImpl: again.fetchImpl as any, env: QBO_ENV })).toEqual({ queued: 0, synced: 0, failed: 0 });
    expect(again.calls).toHaveLength(0);
  });
});
