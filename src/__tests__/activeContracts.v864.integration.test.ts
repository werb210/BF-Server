// BF_SERVER_v864_ACTIVE_CONTRACTS - against real Postgres: a funded application becomes ONE contract (the application is
// not changed), the renewal engine fires each milestone once, the ledger cannot be edited or deleted, Start Renewal
// creates a new pre-filled application and the chain closes when it funds, statements wait for review, and the
// activity lands on the CRM Timeline as a 'contract' row carrying the contract id.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "../db.js";
import { createContractFromApplication, getContractRow, contractView, type Q } from "../activeContracts/repo.js";
import { runEngineTick, type EngineDeps } from "../activeContracts/engine.js";
import { addLedgerEntry, correctLedgerEntry, listLedger } from "../activeContracts/money.js";
import { startRenewal } from "../activeContracts/renewal.js";
import { confirmReview, reviewUploadedStatement } from "../activeContracts/statements.js";
import { loadCrmTimeline } from "../routes/crm/timeline.js";

const db = pool as unknown as Q;
const APP = "ac864000-0000-4000-8000-000000000001";
const CONTACT = "ac864000-0000-4000-8000-0000000000c1";
const COMPANY = "ac864000-0000-4000-8000-0000000000e1";
const OWNER = "ac864000-0000-4000-8000-0000000000a1";
const sent: string[] = [];
const deps = (now: Date): EngineDeps => ({
  now: () => now, quietUntil: () => null,
  sendEmail: async (to) => { sent.push("email:" + to); return true; },
  sendSms: async (to) => { sent.push("sms:" + to); return true; },
});

async function cleanup() {
  const ids = (await pool.query(`SELECT id FROM active_contracts WHERE company_id = $1::uuid`, [COMPANY])).rows.map((r) => r.id);
  if (ids.length) {
    await pool.query(`BEGIN; ALTER TABLE active_contract_ledger DISABLE TRIGGER active_contract_ledger_no_change; ALTER TABLE active_contract_balances DISABLE TRIGGER active_contract_balances_no_change;`);
    for (const t of ["active_contract_ledger", "active_contract_balances", "active_contract_milestones", "active_contract_statement_reviews", "active_contract_documents", "active_contract_expected_payments", "active_contract_opportunities"]) {
      await pool.query(`DELETE FROM ${t} WHERE contract_id = ANY($1::uuid[])`, [ids]);
    }
    await pool.query(`ALTER TABLE active_contract_ledger ENABLE TRIGGER active_contract_ledger_no_change; ALTER TABLE active_contract_balances ENABLE TRIGGER active_contract_balances_no_change; COMMIT;`);
    await pool.query(`DELETE FROM active_contracts WHERE id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query(`DELETE FROM tasks WHERE company_id = $1::uuid`, [COMPANY]);
  await pool.query(`DELETE FROM notifications WHERE user_id = $1::uuid`, [OWNER]);
  await pool.query(`DELETE FROM crm_timeline_events WHERE contact_id = $1::uuid`, [CONTACT]);
  await pool.query(`DELETE FROM applications WHERE company_id = $1::uuid OR id = $2`, [COMPANY, APP]);
  await pool.query(`DELETE FROM contacts WHERE id = $1::uuid`, [CONTACT]);
  await pool.query(`DELETE FROM companies WHERE id = $1::uuid`, [COMPANY]);
  await pool.query(`DELETE FROM users WHERE id = $1::uuid`, [OWNER]);
}

describe("BF v864 Active Contracts (real Postgres)", () => {
  let contractId = "";
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_01_v864_active_contracts.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql); // idempotent
    await cleanup();
    await pool.query(`INSERT INTO users (id, email, role, active) VALUES ($1, 'ac864@example.com', 'Staff', true)`, [OWNER]);
    await pool.query(`INSERT INTO companies (id, name) VALUES ($1, 'De Kruyff Agri Contractors Inc.')`, [COMPANY]);
    await pool.query(`INSERT INTO contacts (id, name, email, company_id, owner_id) VALUES ($1, 'Walter De Kruyff', 'walter@example.com', $2, $3)`, [CONTACT, COMPANY, OWNER]);
    await pool.query(
      `INSERT INTO applications (id, name, created_at, updated_at, pipeline_state, status, company_id, contact_id, owner_user_id, funded_amount, funded_at, metadata, product_category)
       VALUES ($1, 'De Kruyff Agri', now(), now(), 'Accepted', 'ACCEPTED', $2, $3, $4, 750000, now() - interval '660 days', $5::jsonb, 'term')`,
      [APP, COMPANY, CONTACT, OWNER, JSON.stringify({ kyc: { industry: "Agriculture", fundingAmount: 750000 }, applicant: { firstName: "Walter" } })]);
    await pool.query(`INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, status) VALUES (gen_random_uuid(), $1, 'RBC', 750000, '8%', '24 months', 'Monthly', 'accepted')`, [APP]);
  });
  afterAll(async () => { await cleanup().catch((e) => console.warn("cleanup", String(e))); });

  it("creates one contract from the funded application and leaves the application alone", async () => {
    const before = (await pool.query(`SELECT * FROM applications WHERE id = $1`, [APP])).rows[0];
    const a = await createContractFromApplication(db, APP);
    const b = await createContractFromApplication(db, APP);
    expect(a.created).toBe(true);
    expect(b).toEqual({ created: false, contractId: a.contractId });
    contractId = a.contractId!;
    const after = (await pool.query(`SELECT * FROM applications WHERE id = $1`, [APP])).rows[0];
    expect(after).toEqual(before);
    const v = contractView(await getContractRow(db, contractId, "BF"));
    expect(v).toMatchObject({ lender_name: "RBC", term_months: 24, interest_rate: 8, payment_frequency: "monthly", company_id: COMPANY, status: "active" });
    expect(v.balance.basis).toBe("estimated");
  });

  it("the engine fires the latest maturity milestone once: opportunity, task, advisor notice", async () => {
    const now = new Date();
    const first = await runEngineTick(db, deps(now));
    expect(first.failed).toBe(0);
    await runEngineTick(db, deps(now));
    const ms = (await pool.query(`SELECT milestone FROM active_contract_milestones WHERE contract_id = $1 ORDER BY milestone`, [contractId])).rows.map((r) => r.milestone);
    expect(ms).toContain("d90");
    expect(ms).toContain("d120");
    const opps = (await pool.query(`SELECT status FROM active_contract_opportunities WHERE contract_id = $1`, [contractId])).rows;
    expect(opps).toHaveLength(1);
    const tasks = (await pool.query(`SELECT title FROM tasks WHERE company_id = $1`, [COMPANY])).rows;
    expect(tasks.filter((t) => /Renewal outreach/.test(t.title))).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [OWNER])).rows[0].n).toBeGreaterThan(0);
    expect(sent).toEqual([]); // client messages are off until an Admin turns them on
    expect((await pool.query(`SELECT status FROM active_contracts WHERE id = $1`, [contractId])).rows[0].status).not.toBe("active");
  });

  it("the ledger is append-only; corrections reverse", async () => {
    const e = await addLedgerEntry(db, contractId, { entry_type: "commission_received", amount: 1000, notes: "upfront" }, null);
    await expect(pool.query(`UPDATE active_contract_ledger SET amount = 1 WHERE id = $1`, [e.id])).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM active_contract_ledger WHERE id = $1`, [e.id])).rejects.toThrow(/append-only/);
    await correctLedgerEntry(db, contractId, e.id, "entered twice", null);
    await expect(correctLedgerEntry(db, contractId, e.id, "again", null)).rejects.toThrow(/already_corrected/);
    const rows = await listLedger(db, contractId);
    expect(rows.find((r) => r.id === e.id)?.corrected).toBe(true);
    expect(rows.filter((r) => r.is_revenue).reduce((t, r) => t + Number(r.amount), 0)).toBe(0);
  });

  it("a statement waits for review, then one click updates the balance with its source", async () => {
    const doc = (await pool.query(`INSERT INTO active_contract_documents (contract_id, kind, filename, blob_name) VALUES ($1, 'lender_statement', 'statement.pdf', 'x/statement.pdf') RETURNING id::text AS id`, [contractId])).rows[0].id;
    const review = await reviewUploadedStatement(db, contractId, doc, {
      load: async () => ({ buffer: Buffer.from("x"), contentType: "application/pdf" }),
      text: async () => "Balance 540,000 as of 2026-10-01",
      read: async () => ({ balance: "540000", as_of: "2026-10-01", payments_made: 21 }),
    });
    expect(review.status).toBe("pending");
    expect(contractView(await getContractRow(db, contractId, "BF")).balance.basis).toBe("estimated");
    await confirmReview(db, review.id, {}, null);
    const v = contractView(await getContractRow(db, contractId, "BF"));
    expect(v.balance).toMatchObject({ basis: "reported", source: "lender_statement", as_of: "2026-10-01", balance: 540000 });
  });

  it("Start Renewal makes a new pre-filled application; funding it closes the chain", async () => {
    const r = await startRenewal(db, contractId, {});
    const again = await startRenewal(db, contractId, {});
    expect(again).toMatchObject({ applicationId: r.applicationId, created: false });
    const app = (await pool.query(`SELECT pipeline_state, source, metadata, company_id::text AS company_id FROM applications WHERE id = $1`, [r.applicationId])).rows[0];
    expect(app).toMatchObject({ pipeline_state: "draft", source: "renewal", company_id: COMPANY });
    expect(app.metadata.kyc).toEqual({ industry: "Agriculture" });
    expect(app.metadata.renewal.contract_id).toBe(contractId);
    await pool.query(`UPDATE applications SET funded_at = now(), funded_amount = 600000, pipeline_state = 'Accepted' WHERE id = $1`, [r.applicationId]);
    const n = await createContractFromApplication(db, r.applicationId);
    const fresh = (await pool.query(`SELECT previous_contract_id::text AS prev FROM active_contracts WHERE id = $1`, [n.contractId])).rows[0];
    expect(fresh.prev).toBe(contractId);
    expect((await pool.query(`SELECT status FROM active_contracts WHERE id = $1`, [contractId])).rows[0].status).toBe("refinanced");
    expect((await pool.query(`SELECT status FROM active_contract_opportunities WHERE id = $1`, [r.opportunityId])).rows[0].status).toBe("funded");
  });

  it("contract activity is on the contact's Timeline with the contract id", async () => {
    const rows = await loadCrmTimeline(true, CONTACT, "BF");
    const c = rows.filter((x: any) => x.kind === "contract");
    expect(c.length).toBeGreaterThan(3);
    expect(c.map((x: any) => x.title)).toContain("Contract funded");
    expect(c.filter((x: any) => x.title === "Contract funded").map((x: any) => x.extra)).toContain(contractId);
  });
});
