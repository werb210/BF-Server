// BF_SERVER_v867_BROKER_TOOLS_CREDIT_BUREAU - credit bureau pulls behind one provider interface.
//
// Staff ask for the applicant's (or a guarantor's) consent; the person gives it in the client app (typed name, date
// of birth, the consent wording shown), or an Admin records consent from a signed paper form. With consent given in the
// last 90 days, staff pull Equifax Canada or TransUnion Canada. Each pull keeps the key fields (score, trades,
// balances, delinquencies, collections, bankruptcies, judgments, inquiries) and the report PDF (filed on the
// application), feeds the scorecard and the credit summary (applications.metadata.credit_bureau), and counts one
// usage event (credit_pull) for billing.
//
// The Equifax and TransUnion connectors need each bureau's member agreement, credentials and API specification; until
// those are set, they say so and pull nothing. The mock provider (test and demo copies, or CREDIT_BUREAU_MOCK=on)
// returns a realistic report for any name, so the whole flow can be tried.
import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Q } from "./common.js";
import { isoDate, str } from "./common.js";
import { brand, recordUsage } from "./platform.js";
import { pdfSafe } from "./docx.js";
import { normaliseProvince } from "./salesTax.js";

export const BUREAUS = { equifax_ca: "Equifax Canada", transunion_ca: "TransUnion Canada" } as const;
export type Bureau = keyof typeof BUREAUS;
export const CONSENT_DAYS = 90;

export type Subject = {
  first_name: string; last_name: string; date_of_birth: string | null; email: string | null;
  street: string | null; city: string | null; province: string | null; postal_code: string | null;
};

export type BureauReport = {
  hit: boolean; score: number | null; score_model: string | null; file_since: string | null;
  trades: { count: number; open: number; total_balance: number; total_limit: number; past_due: number };
  delinquencies: { d30: number; d60: number; d90: number }; collections: number; bankruptcies: number; judgments: number; inquiries_6m: number;
  pdf: Buffer | null; reference: string | null;
};

export interface CreditBureauProvider {
  id: string;
  configured(): boolean;
  /** What must be set before this provider can pull (shown to Admins). */
  setup: string[];
  pull(bureau: Bureau, subject: Subject): Promise<BureauReport>;
}

export class BureauError extends Error {
  constructor(message: string, public readonly code: "not_configured" | "no_consent" | "failed" | "invalid") { super(message); }
}

const env = (k: string) => String(process.env[k] ?? "").trim();

/** Equifax Canada (consumer: Equifax Canada Consumer Credit Report via the member's system-to-system access). */
export const equifaxProvider: CreditBureauProvider = {
  id: "equifax_ca",
  setup: ["EQUIFAX_CA_MEMBER_NUMBER", "EQUIFAX_CA_SECURITY_CODE", "EQUIFAX_CA_CLIENT_ID", "EQUIFAX_CA_CLIENT_SECRET", "EQUIFAX_CA_API_URL"],
  configured: () => equifaxProvider.setup.every((k) => env(k)),
  async pull() {
    throw new BureauError("The Equifax Canada connection is not switched on yet: it needs the member agreement, credentials and API specification from Equifax.", "not_configured");
  },
};

/** TransUnion Canada (consumer credit report through TransUnion's system-to-system access for members). */
export const transunionProvider: CreditBureauProvider = {
  id: "transunion_ca",
  setup: ["TRANSUNION_CA_SUBSCRIBER_CODE", "TRANSUNION_CA_SUBSCRIBER_PASSWORD", "TRANSUNION_CA_API_URL", "TRANSUNION_CA_CLIENT_CERT"],
  configured: () => transunionProvider.setup.every((k) => env(k)),
  async pull() {
    throw new BureauError("The TransUnion Canada connection is not switched on yet: it needs the subscriber agreement, credentials and API specification from TransUnion.", "not_configured");
  },
};

const seed = (s: string, salt: string) => createHash("sha256").update(`${salt}:${s.toLowerCase()}`).digest().readUInt32BE(0);

/** A believable report for any name (the same name always gets the same report). Never used in production unless asked. */
export const mockProvider: CreditBureauProvider = {
  id: "mock",
  setup: [],
  configured: () => env("CREDIT_BUREAU_MOCK").toLowerCase() === "on" || ["test", "development"].includes(env("NODE_ENV")),
  async pull(bureau, subject) {
    const key = `${subject.first_name} ${subject.last_name} ${subject.date_of_birth ?? ""}`;
    if (/^no\s*hit$/i.test(subject.last_name)) return emptyReport();
    const n = seed(key, bureau);
    const score = 520 + (n % 300);
    const count = 3 + (n % 9), open = 1 + (n % Math.max(1, count - 1));
    const limit = 10000 * (1 + (n % 12)), balance = Math.round(limit * (((n >> 4) % 70) / 100));
    const weak = score < 600;
    const report: BureauReport = {
      hit: true, score, score_model: bureau === "equifax_ca" ? "ERS 2.0 (test)" : "CreditVision Risk (test)", file_since: `${2000 + (n % 20)}-0${1 + (n % 9)}-01`,
      trades: { count, open, total_balance: balance, total_limit: limit, past_due: weak ? 450 : 0 },
      delinquencies: { d30: weak ? 2 : n % 2, d60: weak ? 1 : 0, d90: weak ? 1 : 0 }, collections: weak ? 1 : 0, bankruptcies: 0, judgments: 0, inquiries_6m: n % 4,
      pdf: null, reference: `TEST-${(n % 1e8).toString().padStart(8, "0")}`,
    };
    report.pdf = Buffer.from(await reportPdf(bureau, subject, report, true));
    return report;
  },
};

function emptyReport(): BureauReport {
  return { hit: false, score: null, score_model: null, file_since: null, trades: { count: 0, open: 0, total_balance: 0, total_limit: 0, past_due: 0 },
    delinquencies: { d30: 0, d60: 0, d90: 0 }, collections: 0, bankruptcies: 0, judgments: 0, inquiries_6m: 0, pdf: null, reference: null };
}

const PROVIDERS: Record<Bureau, CreditBureauProvider> = { equifax_ca: equifaxProvider, transunion_ca: transunionProvider };
let override: CreditBureauProvider | null = null;
/** Tests swap the provider. */
export function setBureauProvider(p: CreditBureauProvider | null): void { override = p; }

/** The provider that serves a bureau: the bureau's own connector when it is set up, otherwise the mock where allowed. */
export function providerFor(bureau: Bureau): CreditBureauProvider | null {
  if (override) return override;
  if (PROVIDERS[bureau].configured()) return PROVIDERS[bureau];
  return mockProvider.configured() ? mockProvider : null;
}

export function providerStatus() {
  return (Object.keys(BUREAUS) as Bureau[]).map((b) => {
    const p = providerFor(b);
    return { bureau: b, name: BUREAUS[b], ready: Boolean(p), provider: p?.id ?? null, test_mode: p?.id === "mock", setup: PROVIDERS[b].setup.filter((k) => !env(k)) };
  });
}

/** A summary PDF of the key fields (the mock's report, and the cover for a bureau that sends data only). */
export async function reportPdf(bureau: Bureau, s: Subject, r: BureauReport, test: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let y = 740;
  const line = (t: string, font = F, size = 11) => { page.drawText(pdfSafe(t), { x: 54, y, size, font, color: rgb(0.08, 0.1, 0.14) }); y -= size * 1.6; };
  line(`${BUREAUS[bureau]} credit report${test ? " - TEST DATA, NOT A REAL REPORT" : ""}`, B, 15);
  line(`Pulled for ${brand()} on ${new Date().toISOString().slice(0, 10)}${r.reference ? ` - reference ${r.reference}` : ""}`);
  line(`Subject: ${s.first_name} ${s.last_name}${s.date_of_birth ? `, born ${s.date_of_birth}` : ""}`);
  line(`Address: ${[s.street, s.city, s.province, s.postal_code].filter(Boolean).join(", ") || "-"}`);
  y -= 8;
  if (!r.hit) { line("No credit file was found for this person.", B); return doc.save(); }
  line(`Score: ${r.score ?? "-"} (${r.score_model ?? "-"})`, B, 13);
  line(`File since: ${r.file_since ?? "-"}`);
  line(`Trades: ${r.trades.count} (${r.trades.open} open), balances $${r.trades.total_balance.toLocaleString("en-CA")} of $${r.trades.total_limit.toLocaleString("en-CA")} limits, past due $${r.trades.past_due.toLocaleString("en-CA")}`);
  line(`Late payments: ${r.delinquencies.d30} x 30 days, ${r.delinquencies.d60} x 60 days, ${r.delinquencies.d90} x 90+ days`);
  line(`Collections: ${r.collections}   Bankruptcies / proposals: ${r.bankruptcies}   Judgments: ${r.judgments}`);
  line(`Inquiries in the last 6 months: ${r.inquiries_6m}`);
  return doc.save();
}

// ------------------------------------------------------------------------------------------------ consent
export function consentText(subjectName: string): string {
  return `I, ${subjectName}, consent to ${brand()} and the lenders it works with obtaining my consumer credit report from Equifax Canada and/or TransUnion Canada, `
    + "now and from time to time while my application is considered and while any financing is outstanding, and to exchange credit information about me with them, "
    + "to assess my application and any guarantee I give. I may withdraw this consent at any time, except where the law or an agreement already made requires it.";
}

/** The person the consent is for: the applicant from the application, or a guarantor staff type in. */
export function parseSubject(b: Record<string, unknown>, fallback: Partial<Subject> = {}): Subject | string {
  const first = str(b.first_name ?? fallback.first_name, 100), last = str(b.last_name ?? fallback.last_name, 100);
  if (!first || !last) return "Enter the person's first and last name.";
  const email = str(b.email ?? fallback.email, 200);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "Check the email address.";
  const dob = b.date_of_birth ? isoDate(b.date_of_birth) : fallback.date_of_birth ?? null;
  if (b.date_of_birth && !dob) return "The date of birth is YYYY-MM-DD.";
  return {
    first_name: first, last_name: last, date_of_birth: dob, email: email ? email.toLowerCase() : null,
    street: str(b.street ?? fallback.street, 200), city: str(b.city ?? fallback.city, 100),
    province: normaliseProvince(b.province ?? fallback.province), postal_code: str(b.postal_code ?? fallback.postal_code, 12),
  };
}

/** The applicant's details from the application, to start a consent request. */
export function applicantFrom(app: Record<string, any>, contact: Record<string, any> | null): Partial<Subject> {
  const md = app.metadata ?? {};
  const a = md.applicant ?? {};
  const [cf, ...cl] = String(contact?.name ?? "").trim().split(/\s+/);
  return {
    first_name: a.firstName ?? a.first_name ?? cf ?? undefined, last_name: a.lastName ?? a.last_name ?? (cl.join(" ") || undefined),
    date_of_birth: isoDate(a.dateOfBirth ?? a.dob ?? a.date_of_birth), email: a.email ?? contact?.email ?? null,
    street: a.address ?? a.street ?? md.business?.address ?? null, city: a.city ?? md.business?.city ?? null,
    province: a.province ?? a.state ?? md.business?.province ?? null, postal_code: a.postalCode ?? a.zip ?? md.business?.postalCode ?? null,
  };
}

const CONSENT_COLS = `id::text AS id, application_id, subject_kind, subject, status, consent_text, method, given_name, given_at, attest_note, created_at`;

export async function listConsents(q: Q, applicationId: string) {
  return (await q.query(`SELECT ${CONSENT_COLS} FROM credit_consents WHERE application_id = $1 ORDER BY created_at DESC LIMIT 50`, [applicationId])).rows;
}

export async function requestConsent(q: Q, applicationId: string, subject: Subject, actor: string | null) {
  const name = `${subject.first_name} ${subject.last_name}`;
  const r = await q.query(
    `INSERT INTO credit_consents (application_id, subject, consent_text, requested_by) VALUES ($1, $2::jsonb, $3, $4::uuid) RETURNING ${CONSENT_COLS}`,
    [applicationId, JSON.stringify(subject), consentText(name), actor],
  );
  return r.rows[0];
}

/** The client gives consent: the name typed must match the person's, and a date of birth is needed for the bureau. */
export async function giveConsent(q: Q, applicationId: string, id: string, b: Record<string, unknown>, meta: { ip: string | null; ua: string | null }): Promise<Record<string, any> | string> {
  const c = (await q.query(`SELECT ${CONSENT_COLS} FROM credit_consents WHERE application_id = $1 AND id = $2::uuid LIMIT 1`, [applicationId, id])).rows[0];
  if (!c || c.status !== "requested") return "This consent request is not open.";
  if (b.agree !== true) return "Tick the box to give your consent.";
  const typed = String(b.full_name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const expected = `${c.subject.first_name} ${c.subject.last_name}`.toLowerCase().replace(/\s+/g, " ");
  if (typed !== expected) return `Type your full name as ${c.subject.first_name} ${c.subject.last_name}.`;
  const dob = isoDate(b.date_of_birth) ?? c.subject.date_of_birth;
  if (!dob) return "Enter your date of birth (the bureau needs it to find your file).";
  const r = await q.query(
    `UPDATE credit_consents SET status = 'given', method = 'client_app', given_name = $3, given_at = now(), ip = $4, user_agent = $5,
       subject = subject || jsonb_build_object('date_of_birth', $6::text), updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid AND status = 'requested' RETURNING ${CONSENT_COLS}`,
    [applicationId, id, String(b.full_name).trim().slice(0, 200), meta.ip, meta.ua?.slice(0, 300) ?? null, dob],
  );
  return r.rows[0] ?? "This consent request is not open.";
}

/** An Admin records consent the person gave on a signed form (kept with the note). */
export async function attestConsent(q: Q, applicationId: string, id: string, note: string, actor: string | null) {
  const r = await q.query(
    `UPDATE credit_consents SET status = 'given', method = 'staff_attested', given_at = now(), attested_by = $3::uuid, attest_note = $4, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid AND status = 'requested' RETURNING ${CONSENT_COLS}`,
    [applicationId, id, actor, note.slice(0, 1000)],
  );
  return r.rows[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ pulls
export function keyFields(r: BureauReport) {
  return { hit: r.hit, score: r.score, score_model: r.score_model, file_since: r.file_since, trades: r.trades, delinquencies: r.delinquencies,
    collections: r.collections, bankruptcies: r.bankruptcies, judgments: r.judgments, inquiries_6m: r.inquiries_6m, reference: r.reference };
}

/** applications.metadata.credit_bureau: the latest pull per person and bureau, and the lowest score (for the scorecard
 *  and the credit summary). */
export async function refreshApplicationSummary(q: Q, applicationId: string): Promise<Record<string, unknown>> {
  const r = await q.query(
    `SELECT DISTINCT ON (c.subject->>'first_name', c.subject->>'last_name', p.bureau) p.bureau, p.status, p.score, p.key_fields, p.pulled_at,
            c.subject->>'first_name' AS first_name, c.subject->>'last_name' AS last_name
       FROM credit_pulls p JOIN credit_consents c ON c.id = p.consent_id
      WHERE p.application_id = $1 AND p.status IN ('completed','no_hit')
      ORDER BY c.subject->>'first_name', c.subject->>'last_name', p.bureau, p.pulled_at DESC`,
    [applicationId],
  );
  const pulls = r.rows.map((x: any) => ({ person: `${x.first_name} ${x.last_name}`, bureau: BUREAUS[x.bureau as Bureau] ?? x.bureau, status: x.status, score: x.score,
    delinquencies_90: x.key_fields?.delinquencies?.d90 ?? 0, collections: x.key_fields?.collections ?? 0, bankruptcies: x.key_fields?.bankruptcies ?? 0,
    pulled_on: new Date(x.pulled_at).toISOString().slice(0, 10) }));
  const scores = pulls.map((p: any) => p.score).filter((s: any) => typeof s === "number");
  const summary = { lowest_score: scores.length ? Math.min(...scores) : null, pulls };
  await q.query(`UPDATE applications SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('credit_bureau', $2::jsonb), updated_at = now() WHERE id::text = $1`, [applicationId, JSON.stringify(summary)]);
  return summary;
}

export type FileDoc = (applicationId: string, name: string, bytes: Buffer, mime: string) => Promise<string | null>;

/** Pulls one bureau for a consent. Refused without consent given in the last 90 days, or when the bureau is not set up. */
export async function pullCredit(q: Q, applicationId: string, consentId: string, bureau: Bureau, actor: string | null, file: FileDoc): Promise<Record<string, any>> {
  const c = (await q.query(`SELECT ${CONSENT_COLS} FROM credit_consents WHERE application_id = $1 AND id = $2::uuid LIMIT 1`, [applicationId, consentId])).rows[0];
  if (!c || c.status !== "given" || !c.given_at || Date.now() - new Date(c.given_at).getTime() > CONSENT_DAYS * 86_400_000) {
    throw new BureauError(`A credit report needs the person's consent, given in the last ${CONSENT_DAYS} days.`, "no_consent");
  }
  const provider = providerFor(bureau);
  if (!provider) throw new BureauError(`${BUREAUS[bureau]} is not set up yet.`, "not_configured");
  const subject = c.subject as Subject;
  let report: BureauReport;
  try {
    report = await provider.pull(bureau, subject);
  } catch (err) {
    if (err instanceof BureauError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    await q.query(`INSERT INTO credit_pulls (application_id, consent_id, bureau, provider, status, error, pulled_by) VALUES ($1, $2::uuid, $3, $4, 'failed', $5, $6::uuid)`,
      [applicationId, consentId, bureau, provider.id, message.slice(0, 500), actor]);
    throw new BureauError(`${BUREAUS[bureau]} did not answer. Try again later.`, "failed");
  }
  const pdf = report.pdf ?? Buffer.from(await reportPdf(bureau, subject, report, provider.id === "mock"));
  const ins = await q.query(
    `INSERT INTO credit_pulls (application_id, consent_id, bureau, provider, status, score, key_fields, report_pdf, pulled_by)
     VALUES ($1, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9::uuid) RETURNING id::text AS id`,
    [applicationId, consentId, bureau, provider.id, report.hit ? "completed" : "no_hit", report.score, JSON.stringify(keyFields(report)), pdf, actor],
  );
  const id = ins.rows[0].id as string;
  if (provider.id !== "mock") await recordUsage("credit_pull", `${bureau}:${id}`);
  const docId = await file(applicationId, `${BUREAUS[bureau]} - ${subject.first_name} ${subject.last_name} - ${new Date().toISOString().slice(0, 10)}.pdf`, pdf, "application/pdf");
  if (docId) await q.query(`UPDATE credit_pulls SET report_document_id = $2 WHERE id = $1::uuid`, [id, docId]);
  await refreshApplicationSummary(q, applicationId);
  return { id, bureau, provider: provider.id, status: report.hit ? "completed" : "no_hit", score: report.score, key_fields: keyFields(report), report_document_id: docId };
}

export async function listPulls(q: Q, applicationId: string) {
  return (await q.query(
    `SELECT p.id::text AS id, p.consent_id::text AS consent_id, p.bureau, p.provider, p.status, p.score, p.key_fields, p.report_document_id, p.error, p.pulled_at,
            c.subject->>'first_name' AS first_name, c.subject->>'last_name' AS last_name
       FROM credit_pulls p JOIN credit_consents c ON c.id = p.consent_id WHERE p.application_id = $1 ORDER BY p.pulled_at DESC LIMIT 100`,
    [applicationId],
  )).rows;
}
