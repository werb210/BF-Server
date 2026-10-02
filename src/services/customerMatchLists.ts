// BF_SERVER_CUSTOMER_MATCH_LISTS_v711
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { accessToken } from "./googleAdsConversions.js";
import { consentGiven, userIdentifiersFor, type UserIdentifier } from "./googleAdsEnhanced.js";

export type ListKind = "applicants" | "funded";
export type Member = { contactId: string; ids: UserIdentifier[]; consented: boolean };
const DM = "https://datamanager.googleapis.com/v1";
const BATCH = 500;
const digits = (value: unknown) => String(value ?? "").replace(/[^0-9]/g, "");
export const LIST_NAMES: Record<ListKind, string> = {
  applicants: "Boreal Financial - Applicants (CRM)",
  funded: "Boreal Financial - Funded clients (CRM)",
};
type Fetch = typeof fetch;

function accounts() {
  const customerId = digits(process.env.GOOGLE_ADS_CUSTOMER_ID);
  return { customerId, loginId: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || customerId };
}
export function customerMatchConfigured(): boolean {
  return Boolean(digits(process.env.GOOGLE_ADS_CUSTOMER_ID) && process.env.GOOGLE_ADS_CLIENT_ID && process.env.GOOGLE_ADS_REFRESH_TOKEN);
}
export function createListBody(kind: ListKind) {
  return {
    displayName: LIST_NAMES[kind],
    description: kind === "applicants" ? "People who applied to Boreal Financial or Canadian Business Financing, sent from the Boreal portal." : "Boreal Financial clients whose financing funded, sent automatically from the Boreal portal.",
    integrationCode: `boreal-${kind}`,
    ingestedUserListInfo: { contactIdInfo: { dataSourceType: "DATA_SOURCE_TYPE_FIRST_PARTY" }, uploadKeyTypes: ["CONTACT_ID"] },
    membershipDuration: `${540 * 86400}s`,
  };
}
async function headers() {
  return { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", "login-account": `accountTypes/GOOGLE_ADS/accounts/${accounts().loginId}` };
}
async function safeText(response: Response): Promise<string> {
  try { return await response.text(); } catch (err: any) { logError("customer_match_read_failed", { message: err?.message }); return ""; }
}
export async function ensureUserList(kind: ListKind, fetchImpl: Fetch = fetch): Promise<string> {
  const saved = await pool.query<{ list_id: string }>("SELECT list_id FROM ads_customer_match_lists WHERE kind = $1 LIMIT 1", [kind]);
  if (saved.rows[0]?.list_id) return saved.rows[0].list_id;
  const base = `${DM}/accountTypes/GOOGLE_ADS/accounts/${accounts().customerId}/userLists`;
  let id = "";
  const listed = await fetchImpl(`${base}?pageSize=1000`, { headers: await headers() });
  if (listed.ok) {
    try {
      const body = JSON.parse(await listed.text()) as { userLists?: Array<{ id?: string; displayName?: string }> };
      id = String((body.userLists ?? []).find((list) => list.displayName === LIST_NAMES[kind])?.id ?? "");
    } catch (err: any) { logError("customer_match_list_parse_failed", { message: err?.message }); }
  }
  if (!id) {
    const response = await fetchImpl(base, { method: "POST", headers: await headers(), body: JSON.stringify(createListBody(kind)) });
    const text = await safeText(response);
    if (!response.ok) throw new Error(`create_list_failed ${response.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text || "{}") as { id?: string; name?: string };
    id = String(body.id ?? String(body.name ?? "").split("/").pop() ?? "");
  }
  if (!digits(id)) throw new Error("create_list_failed no id");
  await pool.query("INSERT INTO ads_customer_match_lists (kind, list_id, list_name) VALUES ($1, $2, $3) ON CONFLICT (kind) DO UPDATE SET list_id = EXCLUDED.list_id, list_name = EXCLUDED.list_name", [kind, id, LIST_NAMES[kind]]);
  return id;
}
export function memberBody(listId: string, members: Member[]) {
  const { customerId, loginId } = accounts();
  return {
    destinations: [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: customerId }, loginAccount: { accountType: "GOOGLE_ADS", accountId: loginId }, productDestinationId: digits(listId) }],
    audienceMembers: members.map((member) => ({
      userData: { userIdentifiers: member.ids.map((id) => "hashedEmail" in id ? { emailAddress: id.hashedEmail } : { phoneNumber: id.hashedPhoneNumber }) },
      consent: member.consented ? { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_GRANTED" } : { adUserData: "CONSENT_STATUS_UNSPECIFIED", adPersonalization: "CONSENT_STATUS_UNSPECIFIED" },
    })),
    termsOfService: { customerMatchTermsOfServiceStatus: "ACCEPTED" }, encoding: "HEX",
  };
}
async function upload(listId: string, members: Member[], fetchImpl: Fetch) {
  const out: { sent: number; failed: number; detail?: string } = { sent: 0, failed: 0 };
  for (let i = 0; i < members.length; i += BATCH) {
    const batch = members.slice(i, i + BATCH);
    const response = await fetchImpl(`${DM}/audienceMembers:ingest`, { method: "POST", headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(memberBody(listId, batch)) });
    if (!response.ok) { out.failed += members.length - i; out.detail = (await safeText(response)).slice(0, 300); logError("customer_match_upload_failed", { listId, status: response.status, detail: out.detail }); break; }
    for (const member of batch) await pool.query("INSERT INTO ads_audience_members (list_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [listId, member.contactId]);
    out.sent += batch.length;
  }
  return out;
}
export const APPLICANTS_SQL = `
  WITH bf AS (
    SELECT a.contact_id AS id, max(a.submitted_at) AS applied_at,
           bool_or(lower(COALESCE(a.metadata->'formData'->>'ad_measurement_consent', a.metadata->>'ad_measurement_consent','')) IN ('true','yes')) AS consented
      FROM applications a WHERE a.silo = 'BF' AND a.submitted_at IS NOT NULL AND a.contact_id IS NOT NULL GROUP BY a.contact_id
  ), cbf AS (
    SELECT c.id, c.consent_at AS applied_at, false AS consented FROM contacts c WHERE c.consent_source = 'CBF application terms'
  ), everyone AS (
    SELECT id, max(applied_at) AS applied_at, bool_or(consented) AS consented, bool_or(src = 'BF') AS bf, bool_or(src = 'CBF') AS cbf
      FROM (SELECT id, applied_at, consented, 'BF' AS src FROM bf UNION ALL SELECT id, applied_at, consented, 'CBF' AS src FROM cbf) u GROUP BY id
  )
  SELECT c.id::text AS contact_id, COALESCE(NULLIF(c.name,''), trim(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,''))) AS name,
         c.email, c.phone, e.applied_at, e.consented, e.bf, e.cbf,
         (SELECT m.uploaded_at FROM ads_audience_members m WHERE m.list_id = $1 AND m.contact_id = c.id::text LIMIT 1) AS sent_at
    FROM everyone e JOIN contacts c ON c.id = e.id
   WHERE c.silo = 'BF' AND COALESCE(c.marketing_opt_out, false) = false AND (COALESCE(c.email,'') <> '' OR COALESCE(c.phone,'') <> '')
   ORDER BY e.applied_at DESC NULLS LAST LIMIT 5000`;
export type ApplicantRow = { contact_id: string; name: string | null; email: string | null; phone: string | null; applied_at: string | null; consented: boolean; bf: boolean; cbf: boolean; sent_at: string | null };
export async function listApplicants() {
  const saved = await pool.query<{ list_id: string }>("SELECT list_id FROM ads_customer_match_lists WHERE kind = 'applicants' LIMIT 1");
  const listId = saved.rows[0]?.list_id ?? null;
  return { listId, rows: (await pool.query<ApplicantRow>(APPLICANTS_SQL, [listId ?? "none"])).rows };
}
export async function sendApplicants(contactIds: string[], fetchImpl: Fetch = fetch) {
  const listId = await ensureUserList("applicants", fetchImpl);
  const wanted = new Set(contactIds);
  const members = (await pool.query<ApplicantRow>(APPLICANTS_SQL, [listId])).rows.filter((row) => wanted.has(row.contact_id)).map((row) => ({ contactId: row.contact_id, ids: userIdentifiersFor(row.email, row.phone, true), consented: row.consented === true })).filter((member) => member.ids.length);
  return { listId, ...await upload(listId, members, fetchImpl), skipped: contactIds.length - members.length };
}
export async function syncFundedList(fetchImpl: Fetch = fetch): Promise<{ sent: number; failed: number; detail?: string } | { skipped: string }> {
  if (!customerMatchConfigured()) return { skipped: "not_configured" };
  if (digits(process.env.GOOGLE_ADS_CM_FUNDED_LIST_ID)) return { skipped: "v708_list_in_use" };
  try {
    const listId = await ensureUserList("funded", fetchImpl);
    const { rows } = await pool.query<{ contact_id: string; email: string | null; phone: string | null; consent: string | null }>(`SELECT DISTINCT ON (c.id) c.id::text AS contact_id, c.email, c.phone, COALESCE(a.metadata->'formData'->>'ad_measurement_consent', a.metadata->>'ad_measurement_consent') AS consent FROM applications a JOIN contacts c ON c.id = a.contact_id WHERE a.silo = 'BF' AND (a.funded_at IS NOT NULL OR a.pipeline_state IN ('Accepted','Funded')) AND COALESCE(c.marketing_opt_out, false) = false AND NOT EXISTS (SELECT 1 FROM ads_audience_members m WHERE m.list_id = $1 AND m.contact_id = c.id::text) ORDER BY c.id, a.updated_at DESC LIMIT 5000`, [listId]);
    const members = rows.map((row) => ({ contactId: row.contact_id, ids: userIdentifiersFor(row.email, row.phone, true), consented: consentGiven(row.consent) })).filter((member) => member.ids.length);
    return await upload(listId, members, fetchImpl);
  } catch (err: any) { const detail = String(err?.message ?? err).slice(0, 300); logError("customer_match_funded_failed", { detail }); return { sent: 0, failed: 0, detail }; }
}
export async function listStatus() {
  const { rows } = await pool.query<{ kind: ListKind; list_id: string; members: number }>(`SELECT l.kind, l.list_id, (SELECT count(*)::int FROM ads_audience_members m WHERE m.list_id = l.list_id) AS members FROM ads_customer_match_lists l`);
  return (["applicants", "funded"] as ListKind[]).map((kind) => { const row = rows.find((item) => item.kind === kind); return { kind, name: LIST_NAMES[kind], listId: row?.list_id ?? null, members: row?.members ?? 0 }; });
}
