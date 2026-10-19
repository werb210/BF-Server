// BF_SERVER_v828_APPLICATION_ORIGIN - the origin SQL against the real schema (baseline + migrations): a broker file
// with its split, a referred client, and a website application with no origin.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { applicationOrigin } from "../services/applicationOrigin.js";
import { claimImportedDraftForPhone, importedDraftsForPhone } from "../services/brokerImport/claim.js";

const brokerApp = randomUUID();
const referredApp = randomUUID();
const plainApp = randomUUID();
const importId = randomUUID();
const referrerId = randomUUID();
const contactId = randomUUID();
const tag = "v828" + Math.floor(Math.random() * 1e6);
const draftApp = randomUUID();
const draftPhone = `+1587555${String(1000 + Math.floor(Math.random() * 9000))}`;

const insertApp = (id: string, contact: string | null, metadata: unknown) => pool.query(
  "INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, source, contact_id, metadata) VALUES ($1, $2, now(), now(), 'Received', 'RECEIVED', 'test', $3, $4::jsonb)",
  [id, `Origin ${tag}`, contact, JSON.stringify(metadata)]);

describe("v828 application origin against the real schema", () => {
  beforeAll(async () => {
    await pool.query("INSERT INTO users (id, email, active, first_name, last_name, company_name) VALUES ($1, $2, true, 'Anthony', 'Allen', 'Allen Advisory')", [referrerId, `ref-${tag}@example.com`]);
    await pool.query("INSERT INTO contacts (id, name, referrer_id) VALUES ($1, $2, $3)", [contactId, `Client ${tag}`, referrerId]);
    await insertApp(brokerApp, null, { broker_import: { broker_name: `Avance ${tag}`, import_id: importId, zip_name: "acme.zip" } });
    await pool.query("INSERT INTO broker_imports (id, broker_name, zip_name, application_id, status) VALUES ($1, $2, 'acme.zip', $3, 'awaiting_client')", [importId, `Avance ${tag}`, brokerApp]);
    await pool.query("INSERT INTO broker_deal_confirmations (application_id, broker_name, boreal_pct, broker_pct, terms, status) VALUES ($1, $2, 60, 40, 'On funding', 'accepted')", [brokerApp, `Avance ${tag}`]);
    await insertApp(referredApp, contactId, {});
    await insertApp(plainApp, null, {});
    await pool.query(
      "INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, source, metadata) VALUES ($1, $2, now(), now(), 'draft', 'RECEIVED', 'broker_import', $3::jsonb)",
      [draftApp, `Draft ${tag}`, JSON.stringify({ readiness_phone: draftPhone, broker_prefill: { business: { legalName: `Draft ${tag}` } }, broker_import: { broker_name: "Avance" } })]);
  });

  afterAll(async () => {
    const clean = (sql: string, params: unknown[]) => pool.query(sql, params).catch((e) => console.warn("cleanup", String(e)));
    await clean("DELETE FROM broker_deal_confirmations WHERE application_id = $1", [brokerApp]);
    await clean("DELETE FROM broker_imports WHERE id = $1", [importId]);
    await clean("DELETE FROM applications WHERE id = ANY($1::uuid[])", [[brokerApp, referredApp, plainApp, draftApp]]);
    await clean("DELETE FROM contacts WHERE id = $1", [contactId]);
    await clean("DELETE FROM users WHERE id = $1", [referrerId]);
  });

  it("finds the broker, the referrer, or nothing", async () => {
    expect(await applicationOrigin(brokerApp)).toMatchObject({ kind: "broker", partner: `Avance ${tag}`, zipName: "acme.zip",
      split: { borealPct: 60, partnerPct: 40, terms: "On funding", status: "accepted" } });
    expect((await applicationOrigin(brokerApp))?.sentAt).toBeTruthy();
    expect(await applicationOrigin(referredApp)).toMatchObject({ kind: "referrer", partner: "Anthony Allen", company: "Allen Advisory", email: `ref-${tag}@example.com` });
    expect(await applicationOrigin(plainApp)).toBeNull();
    expect(await applicationOrigin(randomUUID())).toBeNull();
  });

  // BF_SERVER_v828_CLIENT_CLAIM_IMPORT - the client portal lists the imported draft and the client can claim it.
  it("lists and claims an imported draft by the client's phone", async () => {
    const listed = await importedDraftsForPhone(draftPhone.slice(-10));
    expect(listed.map((r) => [r.id, r.ready_to_finish])).toEqual([[draftApp, true]]);
    expect(await claimImportedDraftForPhone(draftApp, "4035550000")).toBeNull();
    const claimed = await claimImportedDraftForPhone(draftApp, draftPhone.slice(-10));
    expect(claimed).toEqual({ applicationId: draftApp, brokerPrefill: { business: { legalName: `Draft ${tag}` } }, brokerName: "Avance" });
    const row = await pool.query("SELECT pipeline_state, metadata->>'broker_claimed_at' AS claimed FROM applications WHERE id = $1", [draftApp]);
    expect(row.rows[0].pipeline_state).toBe("draft"); // stays a draft until the client submits
    expect(row.rows[0].claimed).toBeTruthy();
    // still listed (so the client can come back to it), now as a normal unfinished application
    expect((await importedDraftsForPhone(draftPhone.slice(-10))).map((r) => r.ready_to_finish)).toEqual([false]);
    expect(await claimImportedDraftForPhone(draftApp, draftPhone.slice(-10))).toMatchObject({ applicationId: draftApp });
  });
});
