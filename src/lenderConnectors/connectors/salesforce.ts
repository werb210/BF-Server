// BF_SERVER_v873_LENDER_API - lenders whose broker portal is a Salesforce Experience Cloud site (*.my.site.com).
//
// Many lenders run their broker portal on Salesforce Experience Cloud (Merchant Growth does: merchantadvance.my.site.com).
// When the lender gives the broker's portal user API access (an "API Enabled" profile or permission set) and a
// connected app, the standard, publicly documented Salesforce REST API applies:
//   token    POST {site_url}/services/oauth2/token  (form: grant_type=password | client_credentials |
//            urn:ietf:params:oauth:grant-type:jwt-bearer) -> { access_token, instance_url }
//   create   POST {api}/services/data/{version}/sobjects/{Object}/   -> { id, success }
//   read     GET  {api}/services/data/{version}/sobjects/{Object}/{id}
//   query    GET  {api}/services/data/{version}/query?q=<SOQL>       (offers, conditions on related objects)
//   files    POST {api}/services/data/{version}/sobjects/ContentVersion/  { Title, PathOnClient, VersionData (base64),
//            FirstPublishLocationId: the deal record } - the file appears in the record's Files list
//   pushes   Salesforce Outbound Messages (SOAP, not signed: we check the OrganizationId and the secret in our URL and
//            answer the Ack), or a JSON POST from a Salesforce Flow HTTP callout signed with a shared secret.
// The OBJECTS AND FIELD API NAMES are the lender's own (custom fields end in __c): the Admin maps them per lender, from
// the lender's documentation. Nothing about a particular lender is assumed here.
import { createSign } from "node:crypto";
import type { ConnectorContext, FetchResult, LenderConnector, PackageAttachment, RemoteCondition, RemoteOffer, RemoteUpdate, SubmitResult, UploadResult } from "../types.js";
import { buildMappedBody, getPath } from "../mapping.js";
import { excerpt, parseJson, retryableStatus } from "../http.js";
import { checkUrlShape } from "../ssrf.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export const DEFAULT_SF_API_VERSION = "v60.0";
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const SF_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
export function isSalesforceId(v: unknown): v is string {
  return typeof v === "string" && SF_ID.test(v);
}

function apiVersion(config: Obj): string {
  const v = str(config.api_version);
  return /^v\d{2,3}\.\d$/.test(v) ? v : DEFAULT_SF_API_VERSION;
}

// ── Authentication ──────────────────────────────────────────────────────────
type Token = { accessToken: string; apiBase: string; expiresAt: number };
const tokenCache = new Map<string, Token>();
export function clearSalesforceTokenCache(): void {
  tokenCache.clear();
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** RS256 JWT for the Salesforce JWT bearer flow (iss = client id, sub = user name, aud = login host). */
export function salesforceJwt(clientId: string, username: string, audience: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256" }));
  const claims = b64url(JSON.stringify({ iss: clientId, sub: username, aud: audience, exp: nowSec + 180 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${head}.${claims}`);
  return `${head}.${claims}.${b64url(signer.sign(privateKeyPem))}`;
}

async function getToken(ctx: ConnectorContext, force = false): Promise<{ ok: true; token: Token } | { ok: false; error: string; retryable: boolean }> {
  const site = str(ctx.config.site_url).replace(/\/+$/, "");
  const flow = str(ctx.config.auth_flow) || "password";
  const s = ctx.secrets;
  const cacheKey = `${site}|${flow}|${s.client_id ?? ""}|${s.username ?? ""}`;
  const cached = tokenCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) return { ok: true, token: cached };
  const form = new URLSearchParams();
  if (flow === "client_credentials") {
    form.set("grant_type", "client_credentials");
    form.set("client_id", s.client_id ?? "");
    form.set("client_secret", s.client_secret ?? "");
  } else if (flow === "jwt_bearer") {
    if (!s.private_key || !s.client_id || !s.username) return { ok: false, error: "The JWT sign-in needs the connected app client id, the user name and the private key.", retryable: false };
    let assertion: string;
    try {
      assertion = salesforceJwt(s.client_id, s.username, str(ctx.config.jwt_audience) || "https://login.salesforce.com", s.private_key);
    } catch (err) {
      return { ok: false, error: `The private key could not sign the sign-in request: ${err instanceof Error ? err.message : String(err)}`, retryable: false };
    }
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    form.set("assertion", assertion);
  } else {
    form.set("grant_type", "password");
    form.set("client_id", s.client_id ?? "");
    form.set("client_secret", s.client_secret ?? "");
    form.set("username", s.username ?? "");
    form.set("password", `${s.password ?? ""}${s.security_token ?? ""}`);
  }
  let res;
  try {
    res = await ctx.http({ method: "POST", url: `${site}/services/oauth2/token`, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() });
  } catch (err) {
    return { ok: false, error: `Could not reach the lender's Salesforce sign-in: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
  }
  const json = obj(parseJson(res.text));
  if (res.status !== 200 || !str(json.access_token)) {
    const why = str(json.error_description) || str(json.error) || excerpt(res.text);
    return { ok: false, error: `The lender's Salesforce refused the sign-in (${res.status}): ${why}`, retryable: retryableStatus(res.status) };
  }
  const override = str(ctx.config.api_base_url).replace(/\/+$/, "");
  const token: Token = { accessToken: str(json.access_token), apiBase: override || str(json.instance_url).replace(/\/+$/, "") || site, expiresAt: Date.now() + 30 * 60_000 };
  tokenCache.set(cacheKey, token);
  return { ok: true, token };
}

/** One REST call with the cached token; a 401 refreshes the token once. */
async function sfCall(ctx: ConnectorContext, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(ctx, attempt > 0);
    if (!t.ok) return { ok: false as const, error: t.error, retryable: t.retryable, status: 0 };
    const res = await ctx.http({
      method, url: `${t.token.apiBase}${path}`,
      headers: { Authorization: `Bearer ${t.token.accessToken}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && attempt === 0) continue;
    if (res.status >= 200 && res.status < 300) return { ok: true as const, json: parseJson(res.text), status: res.status };
    const err = parseJson(res.text);
    const msg = Array.isArray(err) ? err.map((e: any) => `${str(e?.errorCode)}: ${str(e?.message)}`).join("; ") : excerpt(res.text);
    return { ok: false as const, error: `Salesforce answered ${res.status}: ${msg}`, retryable: retryableStatus(res.status), status: res.status };
  }
  return { ok: false as const, error: "Salesforce refused the token twice.", retryable: false, status: 401 };
}

const dataPath = (config: Obj, rest: string) => `/services/data/${apiVersion(config)}${rest}`;

/** Only SELECT statements; {{external_id}} / {{record_id}} are filled with validated Salesforce ids. */
export function fillSoql(soql: string, vars: { external_id: string; record_id: string }): string | null {
  const q = str(soql);
  if (!/^select\s/i.test(q) || /;/.test(q)) return null;
  if (!isSalesforceId(vars.external_id) || !isSalesforceId(vars.record_id)) return null;
  return q.replace(/\{\{\s*external_id\s*\}\}/g, vars.external_id).replace(/\{\{\s*record_id\s*\}\}/g, vars.record_id);
}

async function query(ctx: ConnectorContext, soql: string): Promise<unknown[] | null> {
  const r = await sfCall(ctx, "GET", dataPath(ctx.config, `/query?q=${encodeURIComponent(soql)}`));
  if (!r.ok) return null;
  const records = getPath(r.json, "records");
  return Array.isArray(records) ? records.slice(0, 100) : [];
}

function pick(record: unknown, fields: Obj, key: string, fallback: string): unknown {
  const f = str(fields[key]) || fallback;
  return f ? getPath(record, f) : undefined;
}

export function readSalesforceRecord(record: unknown, st: Obj, externalId: string, followed: unknown | null): RemoteUpdate {
  const source = followed ?? record;
  const statusField = followed ? (str(obj(st.follow).status_field) || "StageName") : (str(st.status_field) || "Status");
  const update: RemoteUpdate = { externalId, status: text(getPath(source, statusField)) };
  const labelField = followed ? str(obj(st.follow).label_field) : str(st.label_field);
  if (labelField) update.statusLabel = text(getPath(source, labelField));
  const funded = followed ? str(obj(st.follow).funded_amount_field) : str(st.funded_amount_field);
  if (funded) update.fundedAmount = num(getPath(source, funded));
  const commission = followed ? str(obj(st.follow).commission_field) : str(st.commission_field);
  if (commission) update.commissionAmount = num(getPath(source, commission));
  const note = followed ? str(obj(st.follow).note_field) : str(st.note_field);
  if (note) update.note = text(getPath(source, note));
  // BF_SERVER_v873_LENDER_API - the outstanding balance on a funded deal (Active Contracts).
  const balance = followed ? str(obj(st.follow).balance_field) : str(st.balance_field);
  if (balance) update.balance = num(getPath(source, balance));
  const asOf = followed ? str(obj(st.follow).balance_as_of_field) : str(st.balance_as_of_field);
  if (asOf) update.balanceAsOf = text(getPath(source, asOf));
  return update;
}

function conditionStatus(v: unknown): RemoteCondition["status"] {
  const s = String(v ?? "").toLowerCase();
  if (/waiv/.test(s)) return "waived";
  if (/(satisf|clear|received|complete|met|done|accepted|true)/.test(s)) return "satisfied";
  return "open";
}

async function fetchSalesforce(ctx: ConnectorContext, externalId: string): Promise<FetchResult> {
  if (!isSalesforceId(externalId)) return { ok: false, error: "The saved lender record id is not a Salesforce id.", retryable: false };
  const st = obj(ctx.config.status);
  const object = str(st.object) || str(obj(ctx.config.submit).object);
  if (!SF_NAME.test(object)) return { ok: false, error: "Set the Salesforce object to read the status from.", retryable: false };
  const rec = await sfCall(ctx, "GET", dataPath(ctx.config, `/sobjects/${object}/${externalId}`));
  if (!rec.ok) return { ok: false, error: rec.error, retryable: rec.retryable };
  // A lead the lender converted points at the opportunity that now carries the stage.
  let followed: unknown | null = null;
  let recordId = externalId;
  const follow = obj(st.follow);
  const pointer = str(st.converted_field);
  const followObject = str(follow.object);
  if (pointer && SF_NAME.test(followObject)) {
    const target = getPath(rec.json, pointer);
    if (isSalesforceId(target)) {
      const f = await sfCall(ctx, "GET", dataPath(ctx.config, `/sobjects/${followObject}/${target}`));
      if (f.ok) { followed = f.json; recordId = target; }
    }
  }
  const update = readSalesforceRecord(rec.json, st, externalId, followed);
  if (recordId !== externalId) update.linkedRecordId = recordId;
  const offersSoql = str(st.offers_soql);
  if (offersSoql) {
    const q = fillSoql(offersSoql, { external_id: externalId, record_id: recordId });
    const rows = q ? await query(ctx, q) : null;
    if (rows) {
      const f = obj(st.offer_fields);
      update.offers = rows.map((o, i): RemoteOffer => ({
        externalId: text(pick(o, f, "id", "Id")) ?? `offer-${i + 1}`,
        amount: num(pick(o, f, "amount", "")),
        rateFactor: text(pick(o, f, "rate_factor", "")),
        term: text(pick(o, f, "term", "")),
        paymentFrequency: text(pick(o, f, "payment_frequency", "")),
        expiryDate: text(pick(o, f, "expiry_date", "")),
        status: text(pick(o, f, "status", "")),
        notes: text(pick(o, f, "notes", "")),
      }));
    }
  }
  const condSoql = str(st.conditions_soql);
  if (condSoql) {
    const q = fillSoql(condSoql, { external_id: externalId, record_id: recordId });
    const rows = q ? await query(ctx, q) : null;
    if (rows) {
      const f = obj(st.condition_fields);
      update.conditions = rows.map((c, i): RemoteCondition => {
        const docType = text(pick(c, f, "document_type", ""));
        return {
          externalId: text(pick(c, f, "id", "Id")) ?? `condition-${i + 1}`,
          kind: docType ? "document_request" : "condition",
          description: text(pick(c, f, "description", "Name")) ?? "Condition",
          documentType: docType,
          status: conditionStatus(pick(c, f, "status", "")),
        };
      });
    }
  }
  return { ok: true, update };
}

async function uploadContentVersion(ctx: ConnectorContext, externalId: string, doc: PackageAttachment): Promise<UploadResult> {
  if (!isSalesforceId(externalId)) return { ok: false, error: "The saved lender record id is not a Salesforce id.", retryable: false };
  const r = await sfCall(ctx, "POST", dataPath(ctx.config, "/sobjects/ContentVersion/"), {
    Title: doc.filename.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 255),
    PathOnClient: doc.filename,
    VersionData: doc.content.toString("base64"),
    FirstPublishLocationId: externalId,
  });
  return r.ok ? { ok: true, detail: `${doc.filename} attached to the lender's record` } : { ok: false, error: `${doc.filename}: ${r.error}`, retryable: r.retryable };
}

// ── Outbound Messages (SOAP) ────────────────────────────────────────────────
export const OUTBOUND_MESSAGE_ACK =
  '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound"><Ack>true</Ack></notificationsResponse></soapenv:Body></soapenv:Envelope>';

function xmlDecode(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** { organizationId, records: [{ type, fields }] } from an Outbound Message body. Tolerant of namespace prefixes. */
export function parseOutboundMessage(xml: string): { organizationId: string | null; records: Array<{ type: string | null; fields: Record<string, string> }> } {
  const body = String(xml ?? "").slice(0, 2_000_000);
  const org = body.match(/<(?:\w+:)?OrganizationId>([^<]*)<\/(?:\w+:)?OrganizationId>/);
  const records: Array<{ type: string | null; fields: Record<string, string> }> = [];
  for (const n of body.matchAll(/<(?:\w+:)?sObject\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?sObject>/g)) {
    const typeAttr = n[1]!.match(/type="(?:\w+:)?([A-Za-z0-9_]+)"/);
    const fields: Record<string, string> = {};
    for (const f of n[2]!.matchAll(/<(?:sf:)?([A-Za-z][A-Za-z0-9_]*)>([^<]*)<\/(?:sf:)?\1>/g)) fields[f[1]!] = xmlDecode(f[2]!);
    records.push({ type: typeAttr ? typeAttr[1]! : null, fields });
    if (records.length >= 100) break;
  }
  return { organizationId: org ? org[1]!.trim() : null, records };
}

export const salesforceConnector: LenderConnector = {
  kind: "salesforce",
  label: "Salesforce broker portal (Experience Cloud, *.my.site.com)",
  description: "For lenders whose broker portal is a Salesforce site. Needs the lender to give your portal user API access and a connected app. Map Boreal's fields to their object's field names; status comes back by polling, Outbound Messages or a Flow callout.",
  capabilities: { submit: true, status: true, upload: true, webhook: true },
  availability: "available",
  secretFields: [
    { key: "client_id", label: "Connected app client id (consumer key)", required: true },
    { key: "client_secret", label: "Connected app client secret", required: false, help: "For the password and client credentials sign-ins." },
    { key: "username", label: "Portal user name", required: false, help: "For the password and JWT sign-ins." },
    { key: "password", label: "Portal password", required: false },
    { key: "security_token", label: "Security token", required: false, help: "Only if the lender's Salesforce asks for one with the password sign-in." },
    { key: "private_key", label: "Private key (PEM) for the JWT sign-in", required: false },
    { key: "webhook_secret", label: "Shared secret for Flow callouts", required: false, help: "Only for JSON pushes from a Salesforce Flow; Outbound Messages use the organization id instead." },
  ],

  validateConfig(config) {
    const problems: string[] = [];
    const site = checkUrlShape(config.site_url);
    if (!site.ok) problems.push(`Salesforce site address: ${site.error.replace(/^Webhook URLs/, "Addresses")}`);
    if (str(config.api_base_url)) {
      const api = checkUrlShape(config.api_base_url);
      if (!api.ok) problems.push(`API address: ${api.error.replace(/^Webhook URLs/, "Addresses")}`);
    }
    if (config.auth_flow !== undefined && !["password", "client_credentials", "jwt_bearer"].includes(str(config.auth_flow))) problems.push("Sign-in must be password, client credentials or JWT.");
    const submit = obj(config.submit);
    if (!SF_NAME.test(str(submit.object))) problems.push("Enter the Salesforce object a deal is created as (for example Lead, or Application__c).");
    const map = obj(submit.field_map);
    if (!Object.keys(map).length) problems.push("Map at least one field.");
    for (const k of [...Object.keys(map), ...Object.keys(obj(submit.static_fields))]) if (!SF_NAME.test(k)) problems.push(`"${k}" is not a Salesforce field name.`);
    const st = obj(config.status);
    if (str(st.object) && !SF_NAME.test(str(st.object))) problems.push("The status object is not a Salesforce object name.");
    for (const k of ["offers_soql", "conditions_soql"]) if (str(st[k]) && (!/^select\s/i.test(str(st[k])) || /;/.test(str(st[k])))) problems.push("Offer and condition queries must be a single SELECT.");
    const wh = obj(config.webhook);
    if (wh.mode !== undefined && !["outbound_message", "json", "none"].includes(str(wh.mode))) problems.push("Pushes must be Outbound Messages, JSON or none.");
    if (str(wh.mode) === "outbound_message" && !/^[a-zA-Z0-9]{15,18}$/.test(str(wh.org_id))) problems.push("Outbound Messages need the lender's 18-character Salesforce organization id.");
    if (str(wh.mode) === "json" && wh.signature !== undefined && !["hmac_sha256_hex", "hmac_sha256_base64", "shared_secret_header", "none"].includes(str(wh.signature))) problems.push("Flow pushes must be signed with HMAC-SHA256, a shared secret header, or nothing.");
    return problems;
  },

  defaultStatusMap() {
    return {};
  },

  async submitApplication(ctx, pkg): Promise<SubmitResult> {
    const submit = obj(ctx.config.submit);
    const object = str(submit.object);
    const fieldMap = Object.fromEntries(Object.entries(obj(submit.field_map)).map(([k, v]) => [k, String(v)]));
    const body = buildMappedBody(fieldMap, pkg.values, obj(submit.static_fields));
    let r;
    try {
      r = await sfCall(ctx, "POST", dataPath(ctx.config, `/sobjects/${object}/`), body);
    } catch (err) {
      return { ok: false, error: `Could not reach the lender's Salesforce: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    }
    if (!r.ok) return { ok: false, error: r.error, retryable: r.retryable, httpStatus: r.status };
    const id = text(getPath(r.json, "id"));
    if (!isSalesforceId(id)) return { ok: false, error: "Salesforce accepted the request but returned no record id.", retryable: false };
    const warnings: string[] = [];
    if (submit.attach_documents !== false) {
      for (const a of pkg.attachments) {
        const up = await uploadContentVersion(ctx, id, a).catch((err: unknown) => ({ ok: false as const, error: `${a.filename}: ${err instanceof Error ? err.message : String(err)}`, retryable: true }));
        if (!up.ok) warnings.push(up.error);
      }
    }
    return { ok: true, externalId: id, status: null, detail: `Created ${object} ${id}`, warnings };
  },

  fetchStatus: fetchSalesforce,
  uploadDocument: uploadContentVersion,

  /** JSON pushes (a Flow callout). Outbound Messages are parsed in the webhook route (they are XML). */
  parseWebhook(config, body) {
    const wh = obj(config.webhook);
    const list = str(wh.events_path) ? getPath(body, str(wh.events_path)) : [body];
    const out: RemoteUpdate[] = [];
    for (const ev of Array.isArray(list) ? list.slice(0, 100) : []) {
      const id = text(getPath(ev, str(wh.external_id_field) || "Id"));
      if (!id) continue;
      const u: RemoteUpdate = { externalId: id, status: text(getPath(ev, str(wh.status_field) || str(obj(config.status).status_field) || "Status")) };
      if (str(wh.funded_amount_field)) u.fundedAmount = num(getPath(ev, str(wh.funded_amount_field)));
      if (str(wh.balance_field)) u.balance = num(getPath(ev, str(wh.balance_field)));
      if (str(wh.balance_as_of_field)) u.balanceAsOf = text(getPath(ev, str(wh.balance_as_of_field)));
      out.push(u);
    }
    return out;
  },

  async testConnection(ctx) {
    const t = await getToken(ctx, true);
    if (!t.ok) return { ok: false, message: t.error };
    const r = await sfCall(ctx, "GET", dataPath(ctx.config, "/limits"));
    if (r.ok) return { ok: true, message: "Signed in to the lender's Salesforce and reached its API." };
    if (r.status === 403) return { ok: true, message: "Signed in to the lender's Salesforce. The limits call is not allowed for this user, which is normal for portal users." };
    return { ok: false, message: r.error };
  },
};

/** The status update an Outbound Message record carries, read with the connection's field names. */
export function outboundRecordUpdate(config: Obj, fields: Record<string, string>): RemoteUpdate | null {
  const wh = obj(config.webhook);
  const id = fields[str(wh.external_id_field) || "Id"];
  if (!isSalesforceId(id)) return null;
  const statusField = str(wh.status_field) || str(obj(config.status).status_field) || "Status";
  const u: RemoteUpdate = { externalId: id, status: fields[statusField] ?? null };
  const funded = str(wh.funded_amount_field);
  if (funded) u.fundedAmount = num(fields[funded]);
  if (str(wh.balance_field)) u.balance = num(fields[str(wh.balance_field)]);
  if (str(wh.balance_as_of_field)) u.balanceAsOf = fields[str(wh.balance_as_of_field)] ?? null;
  return u;
}
