// BF_SERVER_v873_LENDER_API - the generic REST/JSON + webhook connector, configured per lender by field mapping.
//
// For any lender that gives brokers a JSON API. The Admin fills in (Lenders > lender > Connection):
//   base_url                      https://api.lender.example
//   auth                          { type: "bearer" | "api_key_header" | "basic" | "none", header_name? }   (secrets:
//                                 api_key, or username + password)
//   extra_headers                 fixed headers the lender asks for (no secrets here; they are stored in plain text)
//   submit   { method, path, field_map: { "lender.json.path": "<source key>" }, static_fields, documents:
//              "inline_base64" | "upload_each" | "none", documents_field, external_id_path, status_path }
//   status   { path ("/deals/{{external_id}}"), status_path, status_label_path, offers_path, offer_fields,
//              conditions_path, condition_fields, funded_amount_path, commission_path, balance_path,
//              balance_as_of_path }
//   upload   { path, mode: "multipart" | "json_base64", file_field, category_field }
//   webhook  { signature: "hmac_sha256_hex" | "hmac_sha256_base64" | "none", signature_header, signature_prefix,
//              timestamp_header, external_id_path, events_path, and the same paths as status }
// Every path in a response is a dotted path ("data.deal.id", "items[0].id").
import type { ConnectorContext, FetchResult, LenderConnector, LenderPackage, PackageAttachment, RemoteCondition, RemoteOffer, RemoteUpdate, SubmitResult, UploadResult } from "../types.js";
import { buildMappedBody, fillPath, getPath, joinUrl, parsePath, setPath } from "../mapping.js";
import { excerpt, multipartBody, parseJson, retryableStatus } from "../http.js";
import { checkUrlShape } from "../ssrf.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const method = (v: unknown, fallback: "GET" | "POST" | "PUT" | "PATCH") => {
  const m = str(v).toUpperCase();
  return (m === "GET" || m === "POST" || m === "PUT" || m === "PATCH" ? m : fallback) as "GET" | "POST" | "PUT" | "PATCH";
};

export function authHeaders(config: Obj, secrets: Record<string, string>): Record<string, string> {
  const auth = obj(config.auth);
  const type = str(auth.type) || "bearer";
  if (type === "none") return {};
  if (type === "basic") {
    const user = secrets.username ?? "";
    const pass = secrets.password ?? "";
    return user || pass ? { Authorization: `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}` } : {};
  }
  const key = secrets.api_key ?? "";
  if (!key) return {};
  if (type === "api_key_header") return { [str(auth.header_name) || "X-API-Key"]: key };
  return { Authorization: `Bearer ${key}` };
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "authorization", "cookie"]);

function extraHeaders(config: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(config.extra_headers))) {
    if (HEADER_NAME.test(k) && !FORBIDDEN_HEADERS.has(k.toLowerCase()) && typeof v === "string" && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}

function headers(ctx: ConnectorContext, extra: Record<string, string> = {}): Record<string, string> {
  return { Accept: "application/json", ...extraHeaders(ctx.config), ...authHeaders(ctx.config, ctx.secrets), ...extra };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

function readOffers(body: unknown, section: Obj): RemoteOffer[] | undefined {
  const path = str(section.offers_path);
  if (!path) return undefined;
  const list = getPath(body, path);
  if (!Array.isArray(list)) return [];
  const f = obj(section.offer_fields);
  const pick = (o: unknown, key: string, fallback: string) => getPath(o, str(f[key]) || fallback);
  return list.slice(0, 50).map((o, i) => ({
    externalId: text(pick(o, "id", "id")) ?? `offer-${i + 1}`,
    amount: num(pick(o, "amount", "amount")),
    rateFactor: text(pick(o, "rate_factor", "rate")),
    term: text(pick(o, "term", "term")),
    paymentFrequency: text(pick(o, "payment_frequency", "payment_frequency")),
    expiryDate: text(pick(o, "expiry_date", "expires_at")),
    status: text(pick(o, "status", "status")),
    notes: text(pick(o, "notes", "notes")),
  }));
}

function conditionStatus(v: unknown): RemoteCondition["status"] {
  const s = String(v ?? "").toLowerCase();
  if (/(waiv)/.test(s)) return "waived";
  if (/(satisf|clear|received|complete|met|done|accepted)/.test(s)) return "satisfied";
  return "open";
}

function readConditions(body: unknown, section: Obj): RemoteCondition[] | undefined {
  const path = str(section.conditions_path);
  if (!path) return undefined;
  const list = getPath(body, path);
  if (!Array.isArray(list)) return [];
  const f = obj(section.condition_fields);
  const pick = (o: unknown, key: string, fallback: string) => getPath(o, str(f[key]) || fallback);
  return list.slice(0, 100).map((c, i) => {
    const docType = text(pick(c, "document_type", "document_type"));
    const kindRaw = String(pick(c, "kind", "type") ?? "").toLowerCase();
    return {
      externalId: text(pick(c, "id", "id")) ?? `condition-${i + 1}`,
      kind: docType || /doc|stip|file/.test(kindRaw) ? "document_request" : "condition",
      description: text(pick(c, "description", "description")) ?? text(pick(c, "name", "name")) ?? "Condition",
      documentType: docType,
      status: conditionStatus(pick(c, "status", "status")),
    };
  });
}

/** Reads a status / webhook body with the paths in `section`. */
export function readUpdate(body: unknown, section: Obj, externalId: string): RemoteUpdate {
  const status = text(getPath(body, str(section.status_path) || "status"));
  const update: RemoteUpdate = { externalId, status };
  const label = str(section.status_label_path);
  if (label) update.statusLabel = text(getPath(body, label));
  const offers = readOffers(body, section);
  if (offers) update.offers = offers;
  const conditions = readConditions(body, section);
  if (conditions) update.conditions = conditions;
  if (str(section.funded_amount_path)) update.fundedAmount = num(getPath(body, str(section.funded_amount_path)));
  if (str(section.commission_path)) update.commissionAmount = num(getPath(body, str(section.commission_path)));
  // BF_SERVER_v873_LENDER_API - the outstanding balance on a funded deal (recorded on the file's Active Contract).
  if (str(section.balance_path)) update.balance = num(getPath(body, str(section.balance_path)));
  if (str(section.balance_as_of_path)) update.balanceAsOf = text(getPath(body, str(section.balance_as_of_path)));
  return update;
}

async function uploadOne(ctx: ConnectorContext, externalId: string, doc: PackageAttachment): Promise<UploadResult> {
  const up = obj(ctx.config.upload);
  const path = str(up.path);
  if (!path) return { ok: false, error: "This connection has no document upload address set.", retryable: false };
  const url = joinUrl(str(ctx.config.base_url), fillPath(path, { external_id: externalId }));
  const mode = str(up.mode) || "multipart";
  let res;
  if (mode === "json_base64") {
    const body: Obj = {};
    const put = (p: string, v: unknown) => { if (p) setPath(body, p, v); };
    put(str(up.filename_field) || "filename", doc.filename);
    put(str(up.category_field) || "category", doc.category);
    put(str(up.file_field) || "content_base64", doc.content.toString("base64"));
    put("content_type", doc.contentType);
    res = await ctx.http({ method: method(up.method, "POST"), url, headers: headers(ctx, { "Content-Type": "application/json" }), body: JSON.stringify(body) });
  } else {
    const parts: Array<{ name: string; value: string | Buffer; filename?: string; contentType?: string }> = [
      { name: str(up.file_field) || "file", value: doc.content, filename: doc.filename, contentType: doc.contentType },
    ];
    if (str(up.category_field)) parts.push({ name: str(up.category_field), value: doc.category });
    const mp = multipartBody(parts);
    res = await ctx.http({ method: method(up.method, "POST"), url, headers: headers(ctx, { "Content-Type": mp.contentType }), body: mp.body });
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, detail: `${doc.filename} uploaded` };
  return { ok: false, error: `${doc.filename}: the lender answered ${res.status} ${excerpt(res.text)}`.trim(), retryable: retryableStatus(res.status) };
}

export const genericRestConnector: LenderConnector = {
  kind: "generic_rest",
  label: "REST/JSON API (configure by field mapping)",
  description: "For any lender with a broker API that takes JSON. Map Boreal's fields to the lender's, say where the deal id and status are in their answers, and optionally receive their webhooks.",
  capabilities: { submit: true, status: true, upload: true, webhook: true },
  availability: "available",
  secretFields: [
    { key: "api_key", label: "API key or token", required: false, help: "For bearer or API-key header authentication." },
    { key: "username", label: "User name", required: false, help: "For basic authentication only." },
    { key: "password", label: "Password", required: false, help: "For basic authentication only." },
    { key: "webhook_secret", label: "Webhook signing secret", required: false, help: "The secret the lender signs its webhooks with. Leave blank to have Boreal make one you give the lender." },
  ],

  validateConfig(config) {
    const problems: string[] = [];
    const base = checkUrlShape(config.base_url);
    if (!base.ok) problems.push(`API address: ${base.error.replace(/^Webhook URLs/, "API addresses")}`);
    const auth = obj(config.auth);
    if (auth.type !== undefined && !["bearer", "api_key_header", "basic", "none"].includes(str(auth.type))) problems.push("Authentication must be bearer, API key header, basic or none.");
    if (str(auth.type) === "api_key_header" && auth.header_name !== undefined && !HEADER_NAME.test(str(auth.header_name))) problems.push("The API key header name may use letters, digits and dashes only.");
    const submit = obj(config.submit);
    if (!str(submit.path)) problems.push("Enter the path deals are submitted to (for example /applications).");
    for (const k of Object.keys(obj(submit.field_map))) if (!parsePath(k)) problems.push(`"${k}" is not a valid field path.`);
    for (const k of Object.keys(obj(submit.static_fields))) if (!parsePath(k)) problems.push(`"${k}" is not a valid field path.`);
    if (!Object.keys(obj(submit.field_map)).length) problems.push("Map at least one field the lender needs.");
    if (submit.documents !== undefined && !["inline_base64", "upload_each", "none"].includes(str(submit.documents))) problems.push("Documents must be sent inline, uploaded one by one, or not at all.");
    if (str(submit.documents) === "upload_each" && !str(obj(config.upload).path)) problems.push("Uploading documents one by one needs the document upload path.");
    const wh = obj(config.webhook);
    if (wh.signature !== undefined && !["hmac_sha256_hex", "hmac_sha256_base64", "shared_secret_header", "none"].includes(str(wh.signature))) problems.push("Webhook signature must be HMAC-SHA256 (hex or base64), a shared secret header, or none.");
    if (wh.signature_header !== undefined && str(wh.signature_header) && !HEADER_NAME.test(str(wh.signature_header))) problems.push("The signature header name may use letters, digits and dashes only.");
    return problems;
  },

  defaultStatusMap() {
    return {};
  },

  async submitApplication(ctx, pkg: LenderPackage): Promise<SubmitResult> {
    const submit = obj(ctx.config.submit);
    const fieldMap = Object.fromEntries(Object.entries(obj(submit.field_map)).map(([k, v]) => [k, String(v)]));
    const body = buildMappedBody(fieldMap, pkg.values, obj(submit.static_fields));
    const docsMode = str(submit.documents) || "inline_base64";
    if (docsMode === "inline_base64") {
      const field = str(submit.documents_field) || "documents";
      const docs = pkg.attachments.map((a) => ({ filename: a.filename, category: a.category, content_type: a.contentType, content_base64: a.content.toString("base64") }));
      setPath(body, field, docs);
    }
    const url = joinUrl(str(ctx.config.base_url), fillPath(str(submit.path), { application_id: pkg.applicationId }));
    let res;
    try {
      res = await ctx.http({ method: method(submit.method, "POST"), url, headers: headers(ctx, { "Content-Type": "application/json", "Idempotency-Key": `bf-${pkg.applicationId}-${pkg.lenderId}` }), body: JSON.stringify(body) });
    } catch (err) {
      return { ok: false, error: `Could not reach the lender: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `The lender answered ${res.status} ${excerpt(res.text)}`.trim(), retryable: retryableStatus(res.status), httpStatus: res.status };
    }
    const json = parseJson(res.text);
    const externalId = text(getPath(json, str(submit.external_id_path) || "id"));
    const status = str(submit.status_path) ? text(getPath(json, str(submit.status_path))) : null;
    const warnings: string[] = [];
    if (!externalId) warnings.push("The lender accepted the deal but its answer had no deal id at the configured path, so status sync cannot follow this deal.");
    if (docsMode === "upload_each" && externalId) {
      for (const a of pkg.attachments) {
        try {
          const up = await uploadOne(ctx, externalId, a);
          if (!up.ok) warnings.push(up.error);
        } catch (err) {
          warnings.push(`${a.filename}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return { ok: true, externalId, status, detail: `Accepted (${res.status})`, warnings };
  },

  async fetchStatus(ctx, externalId): Promise<FetchResult> {
    const st = obj(ctx.config.status);
    if (!str(st.path)) return { ok: false, error: "This connection has no status address set.", retryable: false };
    const url = joinUrl(str(ctx.config.base_url), fillPath(str(st.path), { external_id: externalId }));
    let res;
    try {
      res = await ctx.http({ method: method(st.method, "GET"), url, headers: headers(ctx) });
    } catch (err) {
      return { ok: false, error: `Could not reach the lender: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    }
    if (res.status < 200 || res.status >= 300) return { ok: false, error: `The lender answered ${res.status} ${excerpt(res.text)}`.trim(), retryable: retryableStatus(res.status) };
    return { ok: true, update: readUpdate(parseJson(res.text), st, externalId) };
  },

  uploadDocument: uploadOne,

  parseWebhook(config, body) {
    const wh = obj(config.webhook);
    const eventsPath = str(wh.events_path);
    const events = eventsPath ? getPath(body, eventsPath) : [body];
    const list = Array.isArray(events) ? events : [];
    const out: RemoteUpdate[] = [];
    for (const ev of list.slice(0, 50)) {
      const id = text(getPath(ev, str(wh.external_id_path) || "id"));
      if (id) out.push(readUpdate(ev, wh, id));
    }
    return out;
  },

  async testConnection(ctx) {
    const st = obj(ctx.config.status);
    const testPath = str(obj(ctx.config).test_path) || (str(st.path) && !/\{\{/.test(str(st.path)) ? str(st.path) : "");
    const url = joinUrl(str(ctx.config.base_url), testPath || "/");
    try {
      const res = await ctx.http({ method: "GET", url, headers: headers(ctx) });
      if (res.status === 401 || res.status === 403) return { ok: false, message: `The lender refused the credentials (${res.status}).` };
      if (res.status >= 500) return { ok: false, message: `The lender's API answered ${res.status}. Try again later.` };
      return { ok: true, message: `Reached the lender's API (answered ${res.status}).` };
    } catch (err) {
      return { ok: false, message: `Could not reach the lender's API: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
