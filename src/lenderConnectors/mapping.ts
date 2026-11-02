// BF_SERVER_v873_LENDER_API - field mapping between Boreal's lender package and a lender's API, and lender status names
// to Boreal buckets.
//
// Source keys an Admin can map from (the Connection tab lists them):
//   the normalised business/applicant values below (the same ones the Merchant Growth Google Sheet row uses), and
//   "field:<label>" for any field in the lender package (application ID, requested amount, every wizard answer),
//   "=<text>" for a fixed value (for example "=CAD" or a broker code the lender gave you).
import type { SheetRowData } from "../modules/submissions/merchantGrowthSheet.js";
import { LENDER_BUCKETS, type LenderBucket } from "./types.js";

export type SourceKey = { key: string; label: string; numeric?: boolean };

export const SOURCE_KEYS: SourceKey[] = [
  { key: "applicationId", label: "Application ID" },
  { key: "company", label: "Business name" },
  { key: "firstName", label: "Applicant first name" },
  { key: "lastName", label: "Applicant last name" },
  { key: "email", label: "Applicant email" },
  { key: "mobile", label: "Applicant mobile (10 digits)" },
  { key: "phone", label: "Business phone (10 digits)" },
  { key: "dob", label: "Applicant date of birth (YYYY-MM-DD)" },
  { key: "language", label: "Language (English or French)" },
  { key: "requestedAmount", label: "Requested amount", numeric: true },
  { key: "annualRevenue", label: "Annual revenue", numeric: true },
  { key: "monthlySales", label: "Average monthly sales", numeric: true },
  { key: "street", label: "Business street address" },
  { key: "city", label: "Business city" },
  { key: "province", label: "Business province or state (2 letters)" },
  { key: "country", label: "Business country" },
  { key: "postalCode", label: "Business postal or ZIP code" },
  { key: "yearsInBusiness", label: "Years in business", numeric: true },
  { key: "entityType", label: "Entity type" },
  { key: "industry", label: "Industry" },
  { key: "useOfFunds", label: "Use of funds" },
  { key: "brokerName", label: "Your brokerage name" },
  { key: "brokerEmail", label: "Assigned staff member's email" },
];

const NUMERIC = new Set(SOURCE_KEYS.filter((k) => k.numeric).map((k) => k.key));

export function packageValues(
  row: SheetRowData,
  fields: Array<{ label: string; value: string | number | boolean | null }>,
  extra: { brokerName: string; brokerEmail: string | null },
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(row)) {
    const str = v === undefined || v === null ? "" : String(v);
    if (NUMERIC.has(k)) {
      const n = Number(str.replace(/[^0-9.-]/g, ""));
      out[k] = str.trim() !== "" && Number.isFinite(n) ? n : null;
    } else {
      out[k] = str.trim() === "" ? null : str;
    }
  }
  out.brokerName = extra.brokerName || null;
  out.brokerEmail = extra.brokerEmail || null;
  for (const f of fields) out[`field:${f.label}`] = f.value;
  return out;
}

/** The value a mapping source names: a source key, "field:<label>", or "=<fixed text>". Missing = null. */
export function sourceValue(values: Record<string, unknown>, source: string): unknown {
  const s = String(source ?? "");
  if (s.startsWith("=")) return s.slice(1);
  return Object.prototype.hasOwnProperty.call(values, s) ? (values[s] ?? null) : null;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_$-]{1,64}$/;

/** "a.b[0].c" -> ["a","b",0,"c"]; unsafe or prototype-polluting segments are refused (returns null). */
export function parsePath(path: string): Array<string | number> | null {
  const raw = String(path ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const out: Array<string | number> = [];
  for (const part of raw.split(".")) {
    const m = part.match(/^([^[\]]+)((?:\[\d+\])*)$/);
    if (!m) return null;
    const name = m[1]!;
    if (!SAFE_SEGMENT.test(name) || name === "__proto__" || name === "constructor" || name === "prototype") return null;
    out.push(name);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  return out;
}

export function getPath(obj: unknown, path: string): unknown {
  const parts = parsePath(path);
  if (!parts) return undefined;
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): boolean {
  const parts = parsePath(path);
  if (!parts) return false;
  let cur: any = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    const nextIsIndex = typeof parts[i + 1] === "number";
    if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== "object") cur[p] = nextIsIndex ? [] : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]!] = value;
  return true;
}

/** Builds the lender's JSON body: { "lender.path": "source" } -> nested object. Nulls are left out. */
export function buildMappedBody(fieldMap: Record<string, string>, values: Record<string, unknown>, staticFields: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(staticFields)) setPath(body, path, v);
  for (const [path, source] of Object.entries(fieldMap)) {
    const v = sourceValue(values, source);
    if (v === null || v === undefined || v === "") continue;
    setPath(body, path, v);
  }
  return body;
}

/** "/applications/{{external_id}}" with the id URL-encoded. Only the two known placeholders are filled. */
export function fillPath(template: string, vars: { external_id?: string | null; application_id?: string | null }): string {
  return String(template ?? "")
    .replace(/\{\{\s*external_id\s*\}\}/g, encodeURIComponent(vars.external_id ?? ""))
    .replace(/\{\{\s*application_id\s*\}\}/g, encodeURIComponent(vars.application_id ?? ""));
}

export function joinUrl(base: string, path: string): string {
  if (/^https:\/\//i.test(path)) return path;
  return `${String(base ?? "").replace(/\/+$/, "")}/${String(path ?? "").replace(/^\/+/, "")}`;
}

export function normaliseStatus(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Used only when neither the Admin's map nor the connector's own map names the status. */
export function guessBucket(status: string): LenderBucket {
  const s = normaliseStatus(status);
  if (!s) return "unknown";
  if (/(declin|reject|denied|not approved|closed.?lost|lost)/.test(s)) return "declined";
  if (/(withdr|cancel|abandon)/.test(s)) return "withdrawn";
  if (/(funded|paid out|disburs|closed.?won|complete)/.test(s)) return "funded";
  if (/(stip|condition|document|docs|pending info|need)/.test(s)) return "documents_requested";
  if (/(offer|quote|approv)/.test(s)) return "offer";
  if (/(contract|closing|ready to fund|final|funding)/.test(s)) return "closing";
  if (/(review|underwrit|scor|process|first call)/.test(s)) return "in_review";
  if (/(receiv|submit|new|open)/.test(s)) return "submitted";
  return "unknown";
}

export type StatusMapEntry = { bucket: LenderBucket; stage?: string | null };

export function isBucket(v: unknown): v is LenderBucket {
  return typeof v === "string" && (LENDER_BUCKETS as readonly string[]).includes(v);
}

/** The Admin's map first, then the connector's defaults, then a keyword guess. */
export function resolveStatus(
  status: string,
  adminMap: Record<string, StatusMapEntry>,
  defaults: Record<string, LenderBucket>,
): { bucket: LenderBucket; stage: string | null; source: "admin" | "connector" | "guess" } {
  const key = normaliseStatus(status);
  const admin = adminMap[key];
  if (admin && isBucket(admin.bucket)) return { bucket: admin.bucket, stage: admin.stage ?? null, source: "admin" };
  const defaultKey = Object.keys(defaults).find((k) => normaliseStatus(k) === key);
  if (defaultKey) {
    const bucket = defaults[defaultKey]!;
    return { bucket, stage: DEFAULT_STAGE_FOR_BUCKET[bucket] ?? null, source: "connector" };
  }
  const bucket = guessBucket(key);
  return { bucket, stage: DEFAULT_STAGE_FOR_BUCKET[bucket] ?? null, source: "guess" };
}

/**
 * Which Boreal pipeline stage a lender bucket moves the application to, unless the Admin's status map says
 * otherwise. Deliberately only "offer": one lender declining or funding must not close a file that other lenders are
 * still working, and "documents requested" goes to staff (a notification) rather than straight to the client.
 */
export const DEFAULT_STAGE_FOR_BUCKET: Partial<Record<LenderBucket, string>> = { offer: "Offer" };
