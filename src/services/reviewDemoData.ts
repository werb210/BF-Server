// BF_SERVER_v880_REVIEW_DEMO - sample data for the App Store / Google Play reviewer account.
// Apple rejected the client app (guideline 2.1(a)) because the review login opened an empty account. When the review
// number (REVIEW_LOGIN_PHONE, see reviewLogin.ts) signs in, this gives it a business profile and two applications the
// client portal can show end to end:
//   A - equipment financing, $85,000, at Offer, with two lender offers to review
//   B - working capital, $50,000, Funded (the whole journey completed)
// each with received documents and a short conversation with the advisor.
//
// Rules this follows:
// - Idempotent. The contact carries the tag 'review_demo'; each application carries metadata.review_demo = true and
//   metadata.review_demo_key. A second sign-in creates nothing (it only moves a demo offer's expiry date forward so
//   the offers never show as expired to a later review). An application the reviewer deleted is made again.
// - Everything is in silo 'TEST' and tagged store_review, like quarantineReviewRecords, so staff views, reports,
//   alerts, SMS audiences and outbound webhooks (none listen to TEST) never see it.
// - Nothing is sent. Rows are inserted directly: no SMS, email, push, SignNow, storage or other outside call.
//   Background workers are kept off the rows too: the fraud queue is marked as already handled (its checks call
//   outside services), documents are marked tamper-scanned, banking analysis is skipped, the funded file has no
//   funded_at (that date starts the NPS survey), and active contracts skip silo TEST (activeContracts/repo.ts).
import { randomUUID } from "node:crypto";
import { isReviewPhone } from "./reviewLogin.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
type Client = Q & { release: () => void };
export type DemoDb = { connect: () => Promise<Client> };

export const REVIEW_DEMO_TAG = "review_demo";
export const REVIEW_DEMO_BUSINESS = "Maple Ridge Landscaping Ltd.";
export const REVIEW_DEMO_EMAIL = "review@example.com";

export type ReviewDemoResult =
  | { seeded: false; reason: "not_review_phone" }
  | { seeded: true; contactId: string; applications: Record<DemoKey, string>; created: string[] };

type DemoKey = "equipment" | "working_capital";

const ADVISOR_FALLBACK_NAME = "Boreal Financial Advisor";
const STAFF_ROLES = ["Admin", "Staff", "Ops", "Marketing"];

function e164(raw: string): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "";
}

type DocSpec = { category: string; filename: string };
type OfferSpec = { lender: string; amount: number; rate: string; term: string; frequency: string; expiresInDays: number; status: "pending" | "accepted"; recommended: boolean; createdDaysAgo: number };
type MessageSpec = { daysAgo: number; direction: "outbound" | "inbound"; body: string; read: boolean };
type AppSpec = {
  key: DemoKey;
  productCategory: string;
  amount: number;
  pipelineState: string;
  status: string;
  submittedDaysAgo: number;
  updatedDaysAgo: number;
  fundedAmount: number | null;
  kyc: Record<string, unknown>;
  docs: DocSpec[];
  offers: OfferSpec[];
  messages: (advisorFirstName: string) => MessageSpec[];
};

const BANK = "6 months business bank statements";
const ID = "Government-issued photo ID";
const VOID = "Void cheque";

const APPS: AppSpec[] = [
  {
    key: "equipment",
    productCategory: "EQUIPMENT",
    amount: 85000,
    pipelineState: "Offer",
    status: "SUBMITTED_TO_LENDER",
    submittedDaysAgo: 9,
    updatedDaysAgo: 0,
    fundedAmount: null,
    kyc: { equipmentAmount: "85000", purposeOfFunds: "Buy New Equipment", fundingAmount: "85000", useOfFunds: "Compact excavator for landscaping crews" },
    docs: [
      { category: BANK, filename: "Business bank statements (6 months).pdf" },
      { category: ID, filename: "Driver's licence.jpg" },
      { category: "Equipment quote or invoice", filename: "Excavator quote.pdf" },
      { category: VOID, filename: "Void cheque.pdf" },
    ],
    offers: [
      { lender: "Aspen Equipment Finance (demo)", amount: 85000, rate: "7.9% APR", term: "60 months", frequency: "Monthly", expiresInDays: 14, status: "pending", recommended: true, createdDaysAgo: 2 },
      { lender: "Cedar Leasing (demo)", amount: 85000, rate: "8.4% APR", term: "48 months", frequency: "Monthly", expiresInDays: 10, status: "pending", recommended: false, createdDaysAgo: 2 },
    ],
    messages: (who) => [
      { daysAgo: 9, direction: "outbound", body: `Hi Alex, this is ${who} at Boreal Financial. Thanks for your equipment financing application - I'm looking after your file and will keep you posted here.`, read: true },
      { daysAgo: 8, direction: "outbound", body: "Your bank statements, ID, equipment quote and void cheque are all in. Your file is complete and has gone to our lending partners.", read: true },
      { daysAgo: 2, direction: "outbound", body: "Good news: two lenders have made offers for the excavator. You can compare them under Offers. I'd suggest the Aspen offer - it has the lower rate and no prepayment penalty.", read: false },
    ],
  },
  {
    key: "working_capital",
    productCategory: "WORKING_CAPITAL",
    amount: 50000,
    pipelineState: "Funded",
    status: "ACCEPTED",
    submittedDaysAgo: 75,
    updatedDaysAgo: 60,
    fundedAmount: 50000,
    kyc: { fundingAmount: "50000", purposeOfFunds: "Working capital", useOfFunds: "Seasonal payroll and materials" },
    docs: [
      { category: BANK, filename: "Business bank statements (6 months).pdf" },
      { category: ID, filename: "Driver's licence.jpg" },
      { category: VOID, filename: "Void cheque.pdf" },
      { category: "Business tax returns", filename: "Corporate tax return 2025.pdf" },
    ],
    offers: [
      { lender: "Birch Working Capital (demo)", amount: 50000, rate: "1.18 factor rate", term: "12 months", frequency: "Weekly", expiresInDays: -55, status: "accepted", recommended: true, createdDaysAgo: 68 },
    ],
    messages: (who) => [
      { daysAgo: 68, direction: "outbound", body: "Your working capital offer from Birch is ready - $50,000 over 12 months. Let me know if you have any questions before you accept.", read: true },
      { daysAgo: 67, direction: "inbound", body: "Looks good, we'd like to go ahead with it.", read: true },
      { daysAgo: 60, direction: "outbound", body: `Your $50,000 has been funded and should be in your account today. Congratulations, and thank you for choosing Boreal! - ${who}`, read: true },
    ],
  },
];

async function advisorFor(db: Q): Promise<{ id: string | null; name: string; firstName: string }> {
  const id = String(process.env.REVIEW_DEMO_ADVISOR_USER_ID ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { id: null, name: ADVISOR_FALLBACK_NAME, firstName: "your advisor" };
  const r = await db.query(
    `SELECT id::text AS id, first_name, last_name FROM users
      WHERE id::text = $1 AND role = ANY($2::text[]) AND active IS NOT FALSE AND COALESCE(disabled, false) = false
      LIMIT 1`,
    [id, STAFF_ROLES],
  );
  const u = r.rows[0];
  if (!u) {
    console.warn("[store-review] REVIEW_DEMO_ADVISOR_USER_ID is not an active staff member; demo files have no advisor");
    return { id: null, name: ADVISOR_FALLBACK_NAME, firstName: "your advisor" };
  }
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return { id: u.id, name: name || ADVISOR_FALLBACK_NAME, firstName: String(u.first_name ?? "").trim() || "your advisor" };
}

async function findOrCreateContact(db: Q, phone: string, phone10: string, advisorId: string | null, created: string[]): Promise<string> {
  const found = await db.query(
    `SELECT id::text AS id FROM contacts
      WHERE $2 = ANY(COALESCE(tags, '{}'))
        AND right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = $1
      ORDER BY created_at ASC LIMIT 1`,
    [phone10, REVIEW_DEMO_TAG],
  );
  if (found.rows[0]) return String(found.rows[0].id);
  const id = randomUUID();
  await db.query(
    `INSERT INTO contacts (id, first_name, last_name, name, email, phone, company_name, silo, tags, role, is_primary_applicant,
                           status, lifecycle_stage, owner_id, sms_opt_out, marketing_opt_out, address_city, address_state, address_country,
                           created_at, updated_at)
     VALUES ($1, 'Alex', 'Morgan', 'Alex Morgan', $2, $3, $4, 'TEST', ARRAY['store_review', $5]::text[], 'applicant', true,
             'customer', 'customer', $6::uuid, true, true, 'Calgary', 'AB', 'CA',
             now() - interval '80 days', now())`,
    [id, REVIEW_DEMO_EMAIL, phone, REVIEW_DEMO_BUSINESS, REVIEW_DEMO_TAG, advisorId],
  );
  created.push("contact");
  return id;
}

function metadataFor(spec: AppSpec, phone: string): Record<string, unknown> {
  const requirements = spec.docs.map((d) => ({ document_type: d.category, required: true }));
  return {
    review_demo: true,
    review_demo_key: spec.key,
    store_review: true,
    banking_auto_skip: true,
    businessName: REVIEW_DEMO_BUSINESS,
    product_category: spec.productCategory,
    business: {
      name: REVIEW_DEMO_BUSINESS,
      legalName: REVIEW_DEMO_BUSINESS,
      industry: "Landscaping",
      structure: "Corporation",
      city: "Calgary",
      province: "AB",
      country: "CA",
      yearsInBusiness: "8",
      annualRevenue: "1200000",
      employees: "14",
    },
    applicant: { firstName: "Alex", lastName: "Morgan", email: REVIEW_DEMO_EMAIL, phone, city: "Calgary", province: "AB" },
    kyc: spec.kyc,
    product_questions: spec.key === "equipment"
      ? { equipment: { submitted_at: new Date(Date.now() - spec.submittedDaysAgo * 86_400_000).toISOString(), submitted_by: "client" } }
      : {},
    formData: { productCategory: spec.productCategory, productRequirements: { aggregated: requirements }, termsAccepted: true },
  };
}

async function createApplication(db: Q, spec: AppSpec, contactId: string, phone: string, advisor: { id: string | null; name: string; firstName: string }): Promise<string> {
  const id = randomUUID();
  const days = (n: number) => String(n);
  await db.query(
    `INSERT INTO applications (id, name, business_legal_name, metadata, pipeline_state, status, product_category, requested_amount,
                               funded_amount, source, silo, contact_id, owner_user_id, submitted_at, signnow_app_signed_at,
                               current_step, is_completed, first_opened_at, created_at, updated_at, last_updated)
     VALUES ($1, $2, $2, $3::jsonb, $4, $5, $6, $7, $8, 'review_demo', 'TEST', $9::uuid, $10::uuid,
             now() - ($11 || ' days')::interval, now() - ($11 || ' days')::interval,
             6, true, now() - ($11 || ' days')::interval,
             now() - ($11 || ' days')::interval - interval '1 hour', now() - ($12 || ' days')::interval, now() - ($12 || ' days')::interval)`,
    [id, REVIEW_DEMO_BUSINESS, JSON.stringify(metadataFor(spec, phone)), spec.pipelineState, spec.status, spec.productCategory,
     spec.amount, spec.fundedAmount, contactId, advisor.id, days(spec.submittedDaysAgo), days(spec.updatedDaysAgo)],
  );
  await db.query(
    `INSERT INTO application_contacts (application_id, contact_id, role) VALUES ($1, $2::uuid, 'applicant') ON CONFLICT DO NOTHING`,
    [id, contactId],
  );
  // The fraud worker would run its checks (some call outside services) on a newly submitted file or new documents.
  // Marked as handled for good: never due, and a re-queue only moves requested_at, which stays before done_at.
  await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason, done_at, next_attempt_at)
     VALUES ($1, now(), 'store_review_demo', 'infinity', 'infinity')
     ON CONFLICT (application_id) DO UPDATE SET done_at = 'infinity', next_attempt_at = 'infinity', reason = 'store_review_demo'`,
    [id],
  );
  for (const d of spec.docs) {
    await db.query(
      `INSERT INTO documents (id, application_id, title, display_name, filename, category, document_type, status, uploaded_by,
                              size_bytes, created_at, uploaded_at, updated_at, tamper_scanned_at, tamper_level)
       VALUES ($1, $2, $3, $3, $4, $3, $3, 'accepted', 'client', 245760,
               now() - ($5 || ' days')::interval, now() - ($5 || ' days')::interval, now() - ($5 || ' days')::interval, now(), 'none')`,
      [randomUUID(), id, d.category, d.filename, days(spec.submittedDaysAgo)],
    );
  }
  for (const o of spec.offers) {
    await db.query(
      `INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, recommended,
                           status, notes, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, current_date + $7::int, $8, $9, 'Sample offer for the App Store review account',
               now() - ($10 || ' days')::interval, now() - ($10 || ' days')::interval)`,
      [id, o.lender, o.amount, o.rate, o.term, o.frequency, o.expiresInDays, o.recommended, o.status, days(o.createdDaysAgo)],
    );
  }
  for (const m of spec.messages(advisor.firstName)) {
    await db.query(
      `INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, read_at, created_at)
       VALUES (gen_random_uuid(), 'message', $1, $2, $3, $4::uuid, 'TEST', $5, $6,
               CASE WHEN $7::boolean THEN now() - ($8 || ' days')::interval + interval '2 hours' ELSE NULL END,
               now() - ($8 || ' days')::interval)`,
      [m.direction, m.direction === "outbound" ? "sent" : "received", id, contactId, m.body,
       m.direction === "outbound" ? advisor.name : null, m.read, days(m.daysAgo)],
    );
  }
  return id;
}

/**
 * Seeds (once) the sample data for the store-review number. Returns without touching the database for any other
 * number. Safe to call on every sign-in and from two sign-ins at once (an advisory lock serialises them).
 */
export async function ensureReviewDemoData(rawPhone: string, db?: DemoDb): Promise<ReviewDemoResult> {
  if (!isReviewPhone(rawPhone)) return { seeded: false, reason: "not_review_phone" };
  const phone = e164(rawPhone);
  const phone10 = phone.replace(/[^0-9]/g, "").slice(-10);
  const pool: DemoDb = db ?? ((await import("../db.js")).pool as unknown as DemoDb);
  const client = await pool.connect();
  const created: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["bf_review_demo:" + phone10]);
    const advisor = await advisorFor(client);
    const contactId = await findOrCreateContact(client, phone, phone10, advisor.id, created);
    const applications = {} as Record<DemoKey, string>;
    for (const spec of APPS) {
      const existing = await client.query(
        `SELECT id::text AS id FROM applications
          WHERE contact_id = $1::uuid AND metadata->>'review_demo' = 'true' AND metadata->>'review_demo_key' = $2
          ORDER BY created_at ASC LIMIT 1`,
        [contactId, spec.key],
      );
      if (existing.rows[0]) {
        applications[spec.key] = String(existing.rows[0].id);
        continue;
      }
      applications[spec.key] = await createApplication(client, spec, contactId, phone, advisor);
      created.push(spec.key);
    }
    // A later review (an app update months on) should not find the open offers expired.
    await client.query(
      `UPDATE offers SET expiry_date = current_date + 14
        WHERE application_id = $1 AND status IN ('pending', 'pending_acceptance') AND expiry_date < current_date + 5`,
      [applications.equipment],
    );
    await client.query("COMMIT");
    if (created.length) console.info("[store-review] demo data created", { contactId, created });
    return { seeded: true, contactId, applications, created };
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: unknown) =>
      console.warn("[store-review] demo data rollback failed", rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)));
    throw err;
  } finally {
    client.release();
  }
}
