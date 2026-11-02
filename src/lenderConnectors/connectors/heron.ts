// BF_SERVER_v873_LENDER_API - Heron Data broker submissions.
//
// Many US small-business funders (merchant cash advance and revenue-based lenders) take broker deals through Heron
// Data. The funder creates a broker API key for your brokerage (it starts "bft_") in its Heron account; with it you
// submit deals to that funder. Public documentation (docs.herondata.io, Broker Submissions, read Oct 27 2026):
//   POST https://app.herondata.io/api/broker_submissions/                         { name } -> { heron_id }
//   POST .../api/broker_submissions/{heron_id}/update_information                 company and owner_1 details
//   POST .../api/broker_submissions/{heron_id}/files   multipart: files (1-12 PDFs per request), file_class
// Authentication: header x-api-key. Heron documents no status read-back or webhook for brokers, so this connector
// submits and uploads only; status still comes from the funder by email or their portal.
import type { ConnectorContext, LenderConnector, PackageAttachment, SubmitResult, UploadResult } from "../types.js";
import { excerpt, multipartBody, parseJson, retryableStatus } from "../http.js";

export const HERON_BASE_URL = "https://app.herondata.io";
const MAX_FILES_PER_REQUEST = 12;

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/** Heron's documented file classes, from a package category or file name. Unknown = let Heron classify. */
export function heronFileClass(doc: { category: string; filename: string }): string | null {
  const s = `${doc.category} ${doc.filename}`.toLowerCase();
  if (/bank.?statement|statements/.test(s)) return "bank_statement";
  if (/void|cheque|check/.test(s)) return "void_check";
  if (/tax.?return|t2\b|1120|1065/.test(s)) return "tax_return";
  if (/balance.?sheet/.test(s)) return "balance_sheet";
  if (/p&l|pnl|profit|income.?statement/.test(s)) return "pnl_statement";
  if (/debt/.test(s)) return "debt_summary";
  if (/invoice/.test(s)) return "invoice";
  if (/application/.test(s)) return "iso_application_form";
  return null;
}

function isPdf(doc: PackageAttachment): boolean {
  return doc.contentType === "application/pdf" || /\.pdf$/i.test(doc.filename) || doc.content.subarray(0, 5).toString("latin1") === "%PDF-";
}

function headers(ctx: ConnectorContext, extra: Record<string, string> = {}): Record<string, string> {
  return { Accept: "application/json", "x-api-key": ctx.secrets.api_key ?? "", ...extra };
}

/** The update_information body Heron documents, from Boreal's normalised values. Empty values are left out. */
export function heronInformation(values: Record<string, unknown>, config: Obj): Obj {
  const v = (k: string) => str(values[k]);
  const n = (k: string) => {
    const x = values[k];
    return typeof x === "number" && Number.isFinite(x) ? x : undefined;
  };
  const out: Obj = {};
  const set = (k: string, val: unknown) => { if (val !== undefined && val !== null && val !== "") out[k] = val; };
  set("source_email_address", str(config.source_email_address) || v("brokerEmail"));
  set("company_legal_business_name", v("company"));
  set("company_email", v("email"));
  set("company_phone_number", v("phone"));
  set("amount_requested", n("requestedAmount"));
  set("annual_revenue", n("annualRevenue"));
  set("industry_type", v("industry"));
  const address: Obj = {};
  if (v("street")) address.line_1 = v("street");
  if (v("city")) address.city = v("city");
  if (v("province")) address.state = v("province");
  if (v("postalCode")) address.zip = v("postalCode");
  if (Object.keys(address).length) out.company_physical_address = address;
  const owner: Obj = {};
  if (v("firstName")) owner.first_name = v("firstName");
  if (v("lastName")) owner.last_name = v("lastName");
  if (v("email")) owner.email_address = v("email");
  if (v("mobile")) owner.mobile_phone = v("mobile");
  if (v("dob")) owner.date_of_birth = v("dob");
  if (Object.keys(owner).length) out.owner_1 = owner;
  return out;
}

async function uploadBatch(ctx: ConnectorContext, heronId: string, docs: PackageAttachment[], fileClass: string | null): Promise<UploadResult> {
  const parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }> = docs.map((d) => ({ name: "files", value: d.content, filename: d.filename, contentType: "application/pdf" }));
  if (fileClass) parts.push({ name: "file_class", value: fileClass });
  const mp = multipartBody(parts);
  const res = await ctx.http({ method: "POST", url: `${HERON_BASE_URL}/api/broker_submissions/${encodeURIComponent(heronId)}/files`, headers: headers(ctx, { "Content-Type": mp.contentType }), body: mp.body });
  if (res.status === 201) return { ok: true, detail: `${docs.length} file(s) uploaded` };
  if (res.status === 207) {
    const rows = parseJson(res.text);
    const failed = Array.isArray(rows) ? rows.filter((r: any) => r?.status === "error").map((r: any) => `${str(r?.file)}: ${str(r?.reason)}`) : [];
    return { ok: false, error: `Some files were refused: ${failed.join("; ") || excerpt(res.text)}`, retryable: false };
  }
  return { ok: false, error: `Heron answered ${res.status} ${excerpt(res.text)}`.trim(), retryable: retryableStatus(res.status) };
}

export const heronConnector: LenderConnector = {
  kind: "heron",
  label: "Heron Data broker submissions",
  description: "For funders that take broker deals through Heron Data. The funder gives you a broker API key (it starts with bft_). Heron has no status read-back for brokers, so offers and status still arrive from the funder.",
  capabilities: { submit: true, status: false, upload: true, webhook: false },
  availability: "available",
  secretFields: [{ key: "api_key", label: "Broker API key from the funder (starts with bft_)", required: true }],

  validateConfig(config) {
    const email = str(config.source_email_address);
    return email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? ["The broker email for credit must be an email address."] : [];
  },

  defaultStatusMap() {
    return {};
  },

  async submitApplication(ctx, pkg): Promise<SubmitResult> {
    if (!ctx.secrets.api_key) return { ok: false, error: "No broker API key is saved for this lender.", retryable: false };
    const name = `${str(pkg.values.company) || pkg.lenderName} - ${pkg.applicationId}`.slice(0, 200).padEnd(10, " ");
    let res;
    try {
      res = await ctx.http({ method: "POST", url: `${HERON_BASE_URL}/api/broker_submissions/`, headers: headers(ctx, { "Content-Type": "application/json" }), body: JSON.stringify({ name }) });
    } catch (err) {
      return { ok: false, error: `Could not reach Heron: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `Heron answered ${res.status} ${excerpt(res.text)}`.trim(), retryable: retryableStatus(res.status), httpStatus: res.status };
    const heronId = str((parseJson(res.text) as Obj | null)?.heron_id);
    if (!heronId) return { ok: false, error: "Heron accepted the request but returned no submission id.", retryable: false };

    const warnings: string[] = [];
    const info = await ctx.http({
      method: "POST", url: `${HERON_BASE_URL}/api/broker_submissions/${encodeURIComponent(heronId)}/update_information`,
      headers: headers(ctx, { "Content-Type": "application/json" }), body: JSON.stringify(heronInformation(pkg.values, ctx.config)),
    }).catch((err: unknown) => ({ status: 0, headers: {}, text: err instanceof Error ? err.message : String(err) }));
    if (info.status < 200 || info.status >= 300) warnings.push(`The business and owner details were not saved at Heron (${info.status} ${excerpt(info.text)}).`);

    const pdfs = pkg.attachments.filter(isPdf);
    const skipped = pkg.attachments.filter((a) => !isPdf(a));
    if (skipped.length) warnings.push(`Heron takes PDFs only; not sent: ${skipped.map((s) => s.filename).join(", ")}.`);
    const byClass = new Map<string, PackageAttachment[]>();
    for (const d of pdfs) {
      const c = heronFileClass(d) ?? "";
      byClass.set(c, [...(byClass.get(c) ?? []), d]);
    }
    for (const [cls, docs] of byClass) {
      for (let i = 0; i < docs.length; i += MAX_FILES_PER_REQUEST) {
        const r = await uploadBatch(ctx, heronId, docs.slice(i, i + MAX_FILES_PER_REQUEST), cls || null).catch((err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err), retryable: true }));
        if (!r.ok) warnings.push(r.error);
      }
    }
    return { ok: true, externalId: heronId, status: null, detail: `Heron submission ${heronId}, ${pdfs.length} PDF(s)`, warnings };
  },

  async uploadDocument(ctx, externalId, doc) {
    if (!isPdf(doc)) return { ok: false, error: "Heron takes PDF files only.", retryable: false };
    return uploadBatch(ctx, externalId, [doc], heronFileClass(doc));
  },

  async testConnection(ctx) {
    // Heron documents no read-only broker call, so the test only checks a key is saved and in the documented form.
    const key = ctx.secrets.api_key ?? "";
    if (!key) return { ok: false, message: "No broker API key is saved." };
    if (!/^bft_/.test(key)) return { ok: true, message: "Key saved. Heron broker keys usually start with bft_; check you pasted the broker key, not a funder key." };
    return { ok: true, message: "Key saved. Heron has no test call for brokers; the first submission confirms the key works." };
  },
};
