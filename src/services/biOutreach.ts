import { signServiceToken } from "../auth/serviceTokens.js";
import { logWarn } from "../observability/logger.js";

// BF_SERVER_v789_BI_OUTREACH_VIA_API
// bi_contacts lives in BI-Server's database, not this one: every UPDATE bi_contacts
// that used to run here failed (and was swallowed). The pipeline advance is now a
// call to BI-Server, which owns the forward-only stage rules:
//   POST {BI_SERVER_URL}/api/v1/bi/internal/outreach/advance
//   body { match: { id?, phone?, email? }, to: "contacted" | "engaged" | "demo_booked" }
// Best-effort and non-blocking for callers: it never throws, and a failure is logged.
export type BiOutreachStage = "contacted" | "engaged" | "demo_booked";
export type BiOutreachMatch = { id?: string; phone?: string; email?: string };

const TIMEOUT_MS = 5000;

export function biServerBaseUrl(): string {
  return (process.env.BI_SERVER_URL || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net").replace(/\/+$/, "");
}

export async function advanceBiOutreach(match: BiOutreachMatch, to: BiOutreachStage): Promise<boolean> {
  const clean: BiOutreachMatch = {};
  if (match.id) clean.id = String(match.id);
  if (match.phone) clean.phone = String(match.phone);
  if (match.email) clean.email = String(match.email);
  if (!clean.id && !clean.phone && !clean.email) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const token = signServiceToken("bi-server");
    const resp = await fetch(`${biServerBaseUrl()}/api/v1/bi/internal/outreach/advance`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ match: clean, to }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logWarn("bi_outreach_advance_http", { to, status: resp.status, by: Object.keys(clean) });
      return false;
    }
    return true;
  } catch (err) {
    logWarn("bi_outreach_advance_failed", { to, by: Object.keys(clean), message: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
// When staff first reach out to a BI outreach lead (call or email), advance their
// pipeline stage to Contacted. A BF contact id matches no BI lead, so BI ignores it.
export async function bumpBiOutreachToContacted(contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  await advanceBiOutreach({ id: String(contactId) }, "contacted");
}

// BF_SERVER_BLOCK_v345_BI_OUTREACH_ENGAGED_v1
// An inbound reply from a BI lead advances it to Engaged, matched by phone
// (inbound SMS carries only the sender's number).
export async function bumpBiOutreachToEngagedByPhone(phone: string | null | undefined): Promise<void> {
  if (!phone) return;
  const p = String(phone).trim();
  if (!p.replace(/[^0-9]/g, "")) return;
  await advanceBiOutreach({ phone: p }, "engaged");
}

// BF_SERVER_BLOCK_v744_OUTREACH_AUTOADVANCE_COMPLETE
// An inbound EMAIL reply from a BI lead advances it to Engaged, matched on email.
export async function bumpBiOutreachToEngagedByEmail(email: string | null | undefined): Promise<void> {
  if (!email) return;
  const e = String(email).trim().toLowerCase();
  if (!e) return;
  await advanceBiOutreach({ email: e }, "engaged");
}

// BF_SERVER_BLOCK_v744_OUTREACH_AUTOADVANCE_COMPLETE
// Booking a meeting with a BI lead advances it to Demo Booked.
export async function bumpBiOutreachToDemoBooked(contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  await advanceBiOutreach({ id: String(contactId) }, "demo_booked");
}

// BF_SERVER_v789_BI_OUTREACH_VIA_API - read one BI outreach lead from BI-Server
// (GET {BI_SERVER_URL}/api/v1/bi/internal/outreach/contacts/:id). "not_found" is
// BI's 404; "error" is anything else (network, timeout, 5xx), already logged.
export type BiOutreachLead = { full_name: string | null; email: string | null; phone_e164: string | null; company_id: string | null };
export type BiOutreachLeadResult = { status: "ok"; lead: BiOutreachLead } | { status: "not_found" } | { status: "error" };

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  return s.trim() ? s : null;
}

export async function fetchBiOutreachContact(id: string): Promise<BiOutreachLeadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const token = signServiceToken("bi-server");
    const resp = await fetch(`${biServerBaseUrl()}/api/v1/bi/internal/outreach/contacts/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (resp.status === 404) return { status: "not_found" };
    if (!resp.ok) {
      logWarn("bi_outreach_contact_http", { status: resp.status });
      return { status: "error" };
    }
    const body: any = await resp.json();
    const c = body && typeof body === "object" ? (body.contact ?? body.data ?? body) : null;
    if (!c || typeof c !== "object") {
      logWarn("bi_outreach_contact_bad_body", {});
      return { status: "error" };
    }
    return {
      status: "ok",
      lead: { full_name: strOrNull(c.full_name), email: strOrNull(c.email), phone_e164: strOrNull(c.phone_e164), company_id: strOrNull(c.company_id) },
    };
  } catch (err) {
    logWarn("bi_outreach_contact_failed", { message: err instanceof Error ? err.message : String(err) });
    return { status: "error" };
  } finally {
    clearTimeout(timer);
  }
}
