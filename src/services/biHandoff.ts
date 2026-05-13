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
};
function bestEffortNaics(industry: unknown): { code: string | null; confidence: boolean } {
  if (typeof industry !== "string") return { code: null, confidence: false };
  const key = industry.trim().toLowerCase();
  if (key in NAICS_MAP) return { code: NAICS_MAP[key], confidence: true };
  return { code: null, confidence: false };
}

export type BiHandoffInput = {
  bfApplicationId: string;
  legacyApp: any; // the wizard payload sent on /submit
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

export function buildBiPayload(input: BiHandoffInput): Record<string, unknown> {
  const a = input.legacyApp ?? {};
  const business = a.business ?? a.company ?? {};
  const applicant = a.applicant ?? a.borrower ?? {};
  const kyc = a.kyc ?? a.kyc_answers ?? {};
  const naics = bestEffortNaics(kyc.industry);
  const loanAmount =
    num(kyc.fundingAmount) ??
    num(kyc.capitalAmount) ??
    num(a.capital_amount) ??
    num(kyc.requestedAmount) ??
    null;
  return {
    bf_application_id: input.bfApplicationId,
    guarantor_name: s(applicant.fullName) ?? [s(applicant.firstName), s(applicant.lastName)].filter(Boolean).join(" ") || null,
    guarantor_email: s(applicant.email),
    guarantor_phone: s(applicant.phone),
    guarantor_dob: s(applicant.dob),
    guarantor_address: concatAddress(applicant),
    business_name: s(business.businessName) ?? s(business.legalName) ?? s(business.companyName) ?? s(business.name),
    business_address: concatAddress(business),
    entity_type: s(business.businessStructure) ?? s(business.entityType),
    business_number: s(business.businessNumber),
    naics_code: naics.code,
    naics_confidence: naics.confidence,
    formation_date: s(business.startDate) ?? s(business.formationDate),
    loan_amount: loanAmount,
    pgi_limit: loanAmount != null ? Math.round(loanAmount * 0.8) : null,
    lender_name: s(a.selected_product?.lender_name) ?? s(a.selectedProduct?.lender_id),
    loan_purpose: s(kyc.purposeOfFunds) ?? s(kyc.lookingFor),
    annual_revenue: num(kyc.annualRevenue) ?? num(kyc.revenueLast12Months),
    collateral_value: num(kyc.availableCollateral) ?? num(kyc.fixedAssets),
  };
}

export async function postBiHandoff(input: BiHandoffInput): Promise<BiHandoffResult> {
  const secret = getSecret();
  if (!secret) {
    return { ok: false, error: "no_jwt_secret" };
  }
  const payload = buildBiPayload(input);
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
