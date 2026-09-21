// BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1
// Service-to-service handoff to BI-Server when a BF applicant opts
// into PGI on Step 6. Auth: service JWT signed with the shared
// JWT_SECRET (decision A1 — no new env var).
import jwt from "jsonwebtoken";
import { logError, logInfo } from "../observability/logger.js";

const BI_SERVER_URL =
  process.env.BI_SERVER_URL
  || "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

function getSecret(): string {
  return process.env.JWT_SECRET || "";
}

function mintServiceJwt(): string {
  return jwt.sign(
    { kind: "service", source: "bf-server" },
    getSecret(),
    { expiresIn: "5m" },
  );
}

// Best-effort NAICS lookup (decision NAICS-1). Maps a few common BF
// industry strings to a 6-digit NAICS code. Anything not in the table
// returns { code: null, confidence: false } and BI flags the field as
// required on the completion form.
const NAICS_MAP: Record<string, string> = {
  "manufacturing":       "311000",
  "construction":        "236000",
  "retail":              "440000",
  "retail trade":        "440000",
  "wholesale":           "420000",
  "professional services":"541990",
  "real estate":         "531000",
  "restaurant":          "722500",
  "food service":        "722500",
  "transportation":      "484000",
  "trucking":            "484000",
  "agriculture":         "111000",
  "healthcare":          "621000",
  "technology":          "541510",
  "software":            "541510",
  // BF_SERVER_BI_HANDOFF_FIELDS_v281 - the industries BF-client's Step 1 actually offers.
  "auto sales & repair":     "441000",
  "education":               "611000",
  "energy":                  "221000",
  "hospitality & lodging":   "721000",
  "logistics & trucking":    "484000",
  "personal services":       "812000",
  "restaurant/food service": "722500",
};

// BF_SERVER_BI_HANDOFF_FIELDS_v281
// What a real BF-client submission looked like versus what this mapper read:
//   phone        "(780) 916-7413"  -> sent as-is. BI signs applicants in by E.164
//                (+17809167413), so the applicant could never find or finish
//                their BI application.
//   revenue      "$500,001 to $1,000,000" and collateral "$100,001 to $250,000"
//                are dropdown bands, which Number() turns into null.
//   business no. stored as craBusinessNumber / ein, never businessNumber.
//   NAICS        picked in Step 3 (business.naicsCode) but ignored; and most
//                Step 1 industries were missing from the map.
export function toE164(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** A dropdown band as one figure: midpoint of "X to Y", the floor of "Over X". The applicant confirms it on the BI form. */
export function amountFromBand(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const text = raw.toLowerCase().replace(/zero/g, "0");
  const values = Array.from(text.matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(million|m\b|k\b)?/g)).map((m) => {
    const n = Number(m[1].replace(/,/g, ""));
    const unit = m[2];
    return unit === "million" || unit === "m" ? n * 1_000_000 : unit === "k" ? n * 1_000 : n;
  }).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  if (/\bover\b|\+$/.test(text) || values.length === 1) return values[0] > 0 ? values[0] : null;
  const mid = Math.round((values[0] + values[1]) / 2);
  return mid > 0 ? mid : null;
}
function bestEffortNaics(industry: unknown, picked?: unknown): { code: string | null; confidence: boolean } {
  if (typeof picked === "string" && /^\d{2,6}$/.test(picked.trim())) return { code: picked.trim(), confidence: true }; // v281
  if (typeof industry !== "string") return { code: null, confidence: false };
  const key = industry.trim().toLowerCase();
  if (key in NAICS_MAP) return { code: NAICS_MAP[key], confidence: true };
  return { code: null, confidence: false };
}

export type BiHandoffInput = {
  bfApplicationId: string;
  legacyApp: any; // the wizard payload sent on /submit
  // BF_SERVER_BI_HANDOFF_SOURCES_v1 - optional pre-resolved sources from the
  // caller, which already knows which shape this submission used.
  normalized?: any;
  businessSource?: any;
  applicantSource?: any;
  // v330: when set, overrides the derived loan_amount in the BI payload.
  // Used so each funding app's PGI policy carries the right dollar value.
  loanAmountOverride?: number | null;
};

export type BiHandoffResult =
  | { ok: true; biApplicationId: string; biPublicId: string; completionUrl: string }
  | { ok: false; error: string };

function s(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/[, $]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function concatAddress(o: any): string | null {
  if (!o || typeof o !== "object") return null;
  const parts = [o.street, o.address, o.city, o.state, o.province, o.zip, o.postal, o.postalCode]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  return parts.length ? parts.join(", ") : null;
}

// BF_SERVER_BI_HANDOFF_COUNTRY_v360 - the handoff never said which country the
// business is in, so BI defaulted every referral to Canada. A US applicant then
// failed the form's Canadian postal-code check and could not submit.
export function countryOf(raw: unknown): "CA" | "US" | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "ca" || v === "canada") return "CA";
  if (v === "us" || v === "usa" || v === "united states" || v === "united states of america") return "US";
  return null;
}

// BF_SERVER_BI_HANDOFF_CO_APPLICANT_v390 - the BF co-applicant (Step 4 "partner")
// was never sent, so BI referrals arrived with one guarantor and staff re-keyed
// the second. Sent as a co-guarantor; the SIN/SSN is never sent.
export type BiCoGuarantor = {
  first_name: string | null; last_name: string | null; email: string | null; phone: string | null;
  date_of_birth: string | null; address: string | null; city: string | null; province: string | null;
  postal_code: string | null; ownership: number | null; relationship: string;
};
export function coGuarantorsOf(applicant: any, a: any, n: any): BiCoGuarantor[] {
  const pick = (v: unknown) => (v && typeof v === "object" ? v as Record<string, unknown> : null);
  const p =
    pick(applicant?.partner) ?? pick(a?.partner) ?? pick(n?.partner) ??
    (Array.isArray(a?.applicants) ? pick(a.applicants[1]) : null) ??
    (Array.isArray(n?.applicants) ? pick(n.applicants[1]) : null);
  if (!p) return [];
  const first = s(p.firstName) ?? s(p.first_name);
  const last = s(p.lastName) ?? s(p.last_name);
  if (!first && !last) return [];
  return [{
    first_name: first,
    last_name: last,
    email: s(p.email),
    phone: toE164(s(p.phone)) ?? s(p.phone),
    date_of_birth: s(p.dob) ?? s(p.dateOfBirth) ?? s(p.date_of_birth),
    address: s(p.street) ?? s(p.address),
    city: s(p.city),
    province: s(p.state) ?? s(p.province),
    postal_code: s(p.zip) ?? s(p.postalCode) ?? s(p.postal_code),
    ownership: num(p.ownership),
    relationship: "Co-applicant",
  }];
}

export function buildBiPayload(input: BiHandoffInput): Record<string, unknown> {
  // BF_SERVER_BI_HANDOFF_SOURCES_v1
  // The wizard submits under several shapes. v1Applications.ts already resolves
  // them (business_info, applicants[0], the normalized payload) before calling
  // us; when the caller supplies those, use them. The narrow fallbacks below
  // are what produced BI applications with every field null but NAICS.
  const a = input.legacyApp ?? {};
  const n = input.normalized ?? {};
  const business =
    input.businessSource ??
    a.business ?? a.company ?? a.business_info ?? n.company ?? n.business ?? {};
  const applicant =
    input.applicantSource ??
    a.applicant ?? a.borrower ?? n.applicant ??
    (Array.isArray(a.applicants) ? a.applicants[0] : null) ??
    (Array.isArray(n.applicants) ? n.applicants[0] : null) ?? {};
  const kyc = a.kyc ?? a.kyc_answers ?? n.kyc ?? n.kyc_answers ?? {};
  const naics = bestEffortNaics(kyc.industry, business.naicsCode ?? business.naics_code ?? kyc.naicsCode);
  const derivedLoanAmount =
    num(kyc.fundingAmount) ??
    num(kyc.capitalAmount) ??
    num(a.capital_amount) ??
    num(kyc.requestedAmount) ??
    null;
  // v330: caller can override the derived amount for per-leg PGI policies.
  const loanAmount = (input.loanAmountOverride != null && Number.isFinite(input.loanAmountOverride))
    ? input.loanAmountOverride
    : derivedLoanAmount;
  return {
    bf_application_id: input.bfApplicationId,
    guarantor_name: s(applicant.fullName) ?? ([s(applicant.firstName), s(applicant.lastName)].filter(Boolean).join(" ") || null),
    guarantor_email: s(applicant.email),
    guarantor_phone: toE164(s(applicant.phone)) ?? s(applicant.phone), // v281
    guarantor_dob: s(applicant.dob) ?? s(applicant.dateOfBirth) ?? s(applicant.date_of_birth) ?? s(applicant.birthdate), // BF_SERVER_BLOCK_v331_PGI_DOB_FALLBACKS_v1
    guarantor_address: concatAddress(applicant),
    business_name: s(business.businessName) ?? s(business.legalName) ?? s(business.companyName) ?? s(business.name),
    business_address: concatAddress(business),
    entity_type: s(business.businessStructure) ?? s(business.entityType),
    business_number: s(business.businessNumber) ?? s(business.craBusinessNumber) ?? s(business.ein) ?? s(business.businessNumberCra), // v281
    naics_code: naics.code,
    naics_confidence: naics.confidence,
    formation_date: s(business.startDate) ?? s(business.formationDate),
    loan_amount: loanAmount,
    pgi_limit: loanAmount != null ? Math.round(loanAmount * 0.8) : null,
    lender_name: s(a.selected_product?.lender_name) ?? s(a.selectedProduct?.lender_name) ?? null, // BF_SERVER_BLOCK_v331_PGI_NO_LENDER_UUID_v1 — never send the lender_id UUID; blank if no real name
    loan_purpose: s(kyc.purposeOfFunds) ?? s(kyc.lookingFor),
    annual_revenue: num(kyc.annualRevenue) ?? num(kyc.revenueLast12Months) ?? amountFromBand(kyc.annualRevenue) ?? amountFromBand(kyc.revenueLast12Months), // v281
    collateral_value: num(kyc.availableCollateral) ?? num(kyc.fixedAssets) ?? amountFromBand(kyc.availableCollateral) ?? amountFromBand(kyc.fixedAssets), // v281
    // BF_SERVER_BI_HANDOFF_COUNTRY_v360
    country: countryOf(kyc.businessLocation) ?? countryOf(business.country) ?? countryOf(n.company?.address_country),
    business_website: s(business.website) ?? s(n.company?.website),
    co_guarantors: coGuarantorsOf(applicant, a, n), // v390
  };
}

export async function postBiHandoff(input: BiHandoffInput): Promise<BiHandoffResult> {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, error: "no_jwt_secret" };
  }
  const payload = buildBiPayload(input); // v330: input may carry loanAmountOverride
  const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/applications/from-bf`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${mintServiceJwt()}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      logError("bi_handoff_http_error", { code: "bi_handoff_http_error", status: r.status, body: text.slice(0, 500) });
      return { ok: false, error: `bi_${r.status}` };
    }
    const j: any = await r.json().catch(() => ({}));
    if (!j?.ok || !j?.public_id) {
      return { ok: false, error: "bi_bad_response" };
    }
    logInfo("bi_handoff_success", { bfApplicationId: input.bfApplicationId, biPublicId: j.public_id });
    return {
      ok: true,
      biApplicationId: String(j.application_code || j.public_id),
      biPublicId: String(j.public_id),
      completionUrl: String(j.completion_url || `https://www.boreal.insure/login?next=/applications/${j.public_id}`),
    };
  } catch (err: any) {
    clearTimeout(timeout);
    logError("bi_handoff_exception", { code: "bi_handoff_exception", error: err?.message || "unknown" });
    return { ok: false, error: "bi_exception" };
  }
}
