// BF_SERVER_v873_LENDER_API - connectors, mapping, webhook signatures, credentials, the sync pipeline (with Boreal's
// funding-conditions checklist and Active Contracts balance follow-ups) and the webhook route. Ported from KS-server #53.
import { createHmac, generateKeyPairSync, createVerify } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { answerBySql, callsMatching } from "../../__tests__/helpers/answerBySql.js";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock("../../modules/audit/audit.service.js", () => ({ recordAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../db.js", async () => ({ ...(await vi.importActual<any>("../../db.js")), pool: { query: queryMock }, dbQuery: queryMock }));

import { buildMappedBody, fillPath, getPath, guessBucket, parsePath, resolveStatus, setPath } from "../mapping.js";
import { genericRestConnector } from "../connectors/generic.js";
import { heronConnector, heronFileClass, heronInformation } from "../connectors/heron.js";
import { salesforceConnector, clearSalesforceTokenCache, parseOutboundMessage, fillSoql, salesforceJwt, OUTBOUND_MESSAGE_ACK } from "../connectors/salesforce.js";
import { merchantGrowthConnector, MERCHANT_GROWTH_API_DOCS_RECEIVED, MERCHANT_GROWTH_FIELDS, MERCHANT_GROWTH_REQUESTS } from "../connectors/merchantGrowth.js";
import { verifyWebhook } from "../webhook.js";
import { openSecrets, sealSecrets, publicConnection } from "../store.js";
import { applyRemoteUpdate } from "../sync.js";
import { seal, open, credentialsKeyConfigured } from "../crypto.js";
import { checkUrlShape, isBlockedAddress } from "../ssrf.js";
import type { HttpClient, HttpRequest } from "../http.js";
import type { LenderPackage } from "../types.js";
import { AWAITING_DOCS_ERROR } from "../types.js";
import { retryDelayMinutes } from "../submit.js";

const KEY = "a".repeat(64);

function fakeHttp(handler: (r: HttpRequest) => { status: number; body?: unknown; text?: string }): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  return {
    calls,
    http: async (r) => {
      calls.push(r);
      const out = handler(r);
      return { status: out.status, headers: {}, text: out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body)) };
    },
  };
}

const pkg: LenderPackage = {
  applicationId: "app-1", lenderId: "11111111-1111-1111-1111-111111111111", lenderName: "Test Lender",
  values: { company: "Desklinx", firstName: "Lorne", lastName: "Benjamin", email: "l@example.com", requestedAmount: 70000, "field:Product Category": "LOC", brokerEmail: "staff@broker.example" },
  attachments: [
    { filename: "application-app-1.pdf", contentType: "application/pdf", category: "Signed application", content: Buffer.from("%PDF-1.4 app") },
    { filename: "bank-jan.pdf", contentType: "application/pdf", category: "Bank Statements", content: Buffer.from("%PDF-1.4 bank") },
    { filename: "photo.png", contentType: "image/png", category: "ID", content: Buffer.from("png") },
  ],
  submittedAt: "2026-11-01T00:00:00Z",
};

describe("lender addresses", () => {
  it("allows public https hosts only", () => {
    expect(checkUrlShape("https://api.lender.example/v1").ok).toBe(true);
    expect(checkUrlShape("http://api.lender.example").ok).toBe(false);
    expect(checkUrlShape("https://user:pw@api.lender.example").ok).toBe(false);
    expect(checkUrlShape("https://localhost/x").ok).toBe(false);
    expect(checkUrlShape("https://10.0.0.5/x").ok).toBe(false);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("168.63.129.16")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });
});

describe("mapping", () => {
  it("refuses prototype paths and builds nested bodies", () => {
    expect(parsePath("__proto__.x")).toBeNull();
    expect(parsePath("a.constructor")).toBeNull();
    expect(parsePath("a.b[2].c")).toEqual(["a", "b", 2, "c"]);
    const body = buildMappedBody({ "business.name": "company", "owners[0].first": "firstName", "amount": "requestedAmount", "currency": "=CAD", "missing": "nope" }, pkg.values);
    expect(body).toEqual({ business: { name: "Desklinx" }, owners: [{ first: "Lorne" }], amount: 70000, currency: "CAD" });
    const o: Record<string, unknown> = {};
    expect(setPath(o, "__proto__.polluted", 1)).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
    expect(getPath({ a: [{ b: 3 }] }, "a[0].b")).toBe(3);
    expect(fillPath("/deals/{{external_id}}", { external_id: "a/b" })).toBe("/deals/a%2Fb");
  });

  it("maps statuses: admin map, then connector defaults, then a guess", () => {
    expect(resolveStatus("Funded!", { "funded!": { bucket: "funded", stage: "Accepted" } }, {}).stage).toBe("Accepted");
    expect(resolveStatus("Deal Offer Sent", {}, { "Deal Offer Sent": "offer" })).toMatchObject({ bucket: "offer", stage: "Offer", source: "connector" });
    expect(guessBucket("Closed - Rejected")).toBe("declined");
    expect(guessBucket("Pending stips")).toBe("documents_requested");
    expect(resolveStatus("weird", {}, {}).bucket).toBe("unknown");
  });
});

describe("generic REST connector", () => {
  const config = {
    base_url: "https://api.lender.example",
    auth: { type: "api_key_header", header_name: "X-Key" },
    extra_headers: { "X-Partner": "ks", Authorization: "evil" },
    submit: { path: "/apps", field_map: { "biz.name": "company", amount: "requestedAmount" }, external_id_path: "data.id", status_path: "data.status" },
    status: { path: "/apps/{{external_id}}", status_path: "state", offers_path: "offers", conditions_path: "stips" },
    webhook: { external_id_path: "deal_id", status_path: "state" },
  };

  it("validates settings", () => {
    expect(genericRestConnector.validateConfig({ base_url: "http://x.example" }).length).toBeGreaterThan(0);
    expect(genericRestConnector.validateConfig({ ...config, base_url: "https://localhost" }).some((p) => /internal/.test(p))).toBe(true);
    expect(genericRestConnector.validateConfig(config)).toEqual([]);
  });

  it("submits mapped JSON with inline documents and reads the id and status", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 201, body: { data: { id: "D-9", status: "received" } } }));
    const out = await genericRestConnector.submitApplication({ config, secrets: { api_key: "k123" }, http }, pkg);
    expect(out).toMatchObject({ ok: true, externalId: "D-9", status: "received" });
    expect(calls[0]!.url).toBe("https://api.lender.example/apps");
    expect(calls[0]!.headers!["X-Key"]).toBe("k123");
    expect(calls[0]!.headers!["X-Partner"]).toBe("ks");
    expect(calls[0]!.headers!.Authorization).toBeUndefined();
    const sent = JSON.parse(String(calls[0]!.body));
    expect(sent.biz.name).toBe("Desklinx");
    expect(sent.documents).toHaveLength(3);
  });

  it("marks 5xx retryable and 4xx not", async () => {
    const a = await genericRestConnector.submitApplication({ config, secrets: {}, http: fakeHttp(() => ({ status: 503, text: "down" })).http }, pkg);
    expect(a).toMatchObject({ ok: false, retryable: true });
    const b = await genericRestConnector.submitApplication({ config, secrets: {}, http: fakeHttp(() => ({ status: 422, text: "bad" })).http }, pkg);
    expect(b).toMatchObject({ ok: false, retryable: false });
  });

  it("reads status, offers and conditions", async () => {
    const { http, calls } = fakeHttp(() => ({ status: 200, body: { state: "Approved", offers: [{ id: "o1", amount: "50,000", term: "12 months" }], stips: [{ id: "s1", description: "Void cheque", document_type: "void_check", status: "open" }] } }));
    const out = await genericRestConnector.fetchStatus!({ config, secrets: {}, http }, "D-9");
    expect(calls[0]!.url).toBe("https://api.lender.example/apps/D-9");
    expect(out).toMatchObject({ ok: true, update: { status: "Approved", offers: [{ externalId: "o1", amount: 50000, term: "12 months" }], conditions: [{ externalId: "s1", kind: "document_request", status: "open" }] } });
  });

  it("parses webhooks", () => {
    expect(genericRestConnector.parseWebhook!(config, { deal_id: "D-9", state: "Funded" })).toEqual([{ externalId: "D-9", status: "Funded" }]);
  });
});

describe("Heron connector", () => {
  it("creates, updates and uploads PDFs only, by documented endpoints", async () => {
    const { http, calls } = fakeHttp((r) => (r.url.endsWith("/api/broker_submissions/") ? { status: 200, body: { heron_id: "hrn_1" } } : r.url.endsWith("/files") ? { status: 201, body: [] } : { status: 200, body: {} }));
    const out = await heronConnector.submitApplication({ config: {}, secrets: { api_key: "bft_x" }, http }, pkg);
    expect(out).toMatchObject({ ok: true, externalId: "hrn_1" });
    expect(calls[0]!.headers!["x-api-key"]).toBe("bft_x");
    expect(JSON.parse(String(calls[0]!.body)).name.length).toBeGreaterThanOrEqual(10);
    expect(calls.some((c) => c.url.endsWith("/hrn_1/update_information"))).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/hrn_1/files"))).toHaveLength(2); // two file classes
    expect((out as any).warnings.join(" ")).toMatch(/photo\.png/);
    expect(heronFileClass({ category: "Bank Statements", filename: "x.pdf" })).toBe("bank_statement");
    expect(heronInformation(pkg.values, {})).toMatchObject({ source_email_address: "staff@broker.example", company_legal_business_name: "Desklinx", owner_1: { first_name: "Lorne" } });
  });
});

describe("Salesforce connector", () => {
  beforeEach(() => clearSalesforceTokenCache());
  const config = {
    site_url: "https://lender.my.site.com", auth_flow: "password",
    submit: { object: "Lead", field_map: { Company: "company", LastName: "lastName" } },
    status: { object: "Lead", status_field: "Status", converted_field: "ConvertedOpportunityId", follow: { object: "Opportunity", status_field: "StageName" }, offers_soql: "SELECT Id, Amount__c FROM Quote__c WHERE Opportunity__c = '{{record_id}}'", offer_fields: { amount: "Amount__c" } },
    webhook: { mode: "outbound_message", org_id: "00D000000000001AAA", status_field: "StageName" },
  };
  const sfHttp = () => fakeHttp((r) => {
    if (r.url.endsWith("/services/oauth2/token")) return { status: 200, body: { access_token: "tok", instance_url: "https://lender.my.salesforce.com" } };
    if (r.method === "POST" && /sobjects\/Lead\/$/.test(r.url)) return { status: 201, body: { id: "00Q000000000001AAA", success: true } };
    if (/ContentVersion/.test(r.url)) return { status: 201, body: { id: "068000000000001AAA" } };
    if (/sobjects\/Lead\/00Q/.test(r.url)) return { status: 200, body: { Status: "Converted", ConvertedOpportunityId: "006000000000001AAA" } };
    if (/sobjects\/Opportunity\/006/.test(r.url)) return { status: 200, body: { StageName: "Deal Offer Sent" } };
    if (/\/query\?q=/.test(r.url)) return { status: 200, body: { records: [{ Id: "a0Q000000000001AAA", Amount__c: 25000 }] } };
    return { status: 404, text: "[]" };
  });

  it("validates", () => {
    expect(salesforceConnector.validateConfig(config)).toEqual([]);
    expect(salesforceConnector.validateConfig({ ...config, submit: { object: "Lead; DROP", field_map: { "bad name": "x" } } }).length).toBeGreaterThan(1);
  });

  it("signs in at the site, creates the record and attaches files", async () => {
    const { http, calls } = sfHttp();
    const out = await salesforceConnector.submitApplication({ config, secrets: { client_id: "c", client_secret: "s", username: "u", password: "p" }, http }, pkg);
    expect(out).toMatchObject({ ok: true, externalId: "00Q000000000001AAA" });
    expect(calls[0]!.url).toBe("https://lender.my.site.com/services/oauth2/token");
    expect(String(calls[0]!.body)).toContain("grant_type=password");
    expect(calls[1]!.url).toBe("https://lender.my.salesforce.com/services/data/v60.0/sobjects/Lead/");
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ Company: "Desklinx", LastName: "Benjamin" });
    expect(calls.filter((c) => /ContentVersion/.test(c.url))).toHaveLength(3);
  });

  it("follows a converted lead to the opportunity and reads offers by SOQL", async () => {
    const { http } = sfHttp();
    const out = await salesforceConnector.fetchStatus!({ config, secrets: { client_id: "c" }, http }, "00Q000000000001AAA");
    expect(out).toMatchObject({ ok: true, update: { status: "Deal Offer Sent", linkedRecordId: "006000000000001AAA", offers: [{ amount: 25000 }] } });
  });

  it("only fills SOQL with real ids and only allows SELECT", () => {
    expect(fillSoql("SELECT Id FROM X WHERE Y = '{{record_id}}'", { external_id: "x' OR 1=1", record_id: "x" })).toBeNull();
    expect(fillSoql("DELETE FROM X", { external_id: "00Q000000000001AAA", record_id: "00Q000000000001AAA" })).toBeNull();
  });

  it("parses Outbound Messages", () => {
    const xml = `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><notifications xmlns="http://soap.sforce.com/2005/09/outbound"><OrganizationId>00D000000000001AAA</OrganizationId><Notification><Id>04l1</Id><sObject xsi:type="sf:Opportunity" xmlns:sf="urn:sobject.enterprise.soap.sforce.com"><sf:Id>006000000000001AAA</sf:Id><sf:StageName>Ready to Fund</sf:StageName></sObject></Notification></notifications></soapenv:Body></soapenv:Envelope>`;
    expect(parseOutboundMessage(xml)).toEqual({ organizationId: "00D000000000001AAA", records: [{ type: "Opportunity", fields: { Id: "006000000000001AAA", StageName: "Ready to Fund" } }] });
  });

  it("builds a verifiable RS256 JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = salesforceJwt("cid", "user@x", "https://login.salesforce.com", privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1000);
    const [h, c, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(sig!.replace(/-/g, "+").replace(/_/g, "/"), "base64"))).toBe(true);
    expect(JSON.parse(Buffer.from(c!, "base64url").toString())).toMatchObject({ iss: "cid", sub: "user@x", exp: 1180 });
  });
});

describe("Merchant Growth connector", () => {
  it("is held until Merchant Growth sends API docs and never calls out", async () => {
    expect(MERCHANT_GROWTH_API_DOCS_RECEIVED).toBe(false);
    expect(merchantGrowthConnector.availability).toBe("awaiting_lender_api_docs");
    const { http, calls } = fakeHttp(() => ({ status: 200 }));
    expect(await merchantGrowthConnector.submitApplication({ config: {}, secrets: {}, http }, pkg)).toEqual({ ok: false, error: AWAITING_DOCS_ERROR, retryable: false });
    expect(await merchantGrowthConnector.fetchStatus!({ config: {}, secrets: {}, http }, "x")).toMatchObject({ ok: false, error: AWAITING_DOCS_ERROR });
    expect(calls).toHaveLength(0);
    expect(MERCHANT_GROWTH_FIELDS.every((f) => f.guessed && f.apiName === null)).toBe(true);
    expect(MERCHANT_GROWTH_REQUESTS.join(" ")).toMatch(/connected app/);
    expect(merchantGrowthConnector.defaultStatusMap({})["Closed - Rejected"]).toBe("declined");
  });
});

describe("webhook signatures", () => {
  const body = '{"deal_id":"D-9"}';
  it("checks HMAC hex with prefix and timestamp, and refuses stale or wrong ones", () => {
    const ts = "1700000000";
    const mac = createHmac("sha256", "s3cret").update(`${ts}.${body}`).digest("hex");
    const base = { scheme: "hmac_sha256_hex", secret: "s3cret", rawBody: body, signatureHeader: "X-Sig", signaturePrefix: "sha256=", timestampHeader: "X-Ts" };
    expect(verifyWebhook({ ...base, headers: { "x-sig": `sha256=${mac}`, "x-ts": ts }, nowMs: 1700000000_000 })).toEqual({ ok: true });
    expect(verifyWebhook({ ...base, headers: { "x-sig": `sha256=${mac}`, "x-ts": ts }, nowMs: 1700001000_000 })).toEqual({ ok: false, reason: "stale" });
    expect(verifyWebhook({ ...base, headers: { "x-sig": "sha256=00", "x-ts": ts }, nowMs: 1700000000_000 })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifyWebhook({ ...base, headers: {} })).toEqual({ ok: false, reason: "missing_signature" });
    expect(verifyWebhook({ scheme: "shared_secret_header", secret: "abc", rawBody: body, headers: { "x-webhook-secret": "abc" } })).toEqual({ ok: true });
  });
});

describe("credentials", () => {
  it("seals and opens, and never exposes the sealed value", () => {
    const env = { LENDER_CREDENTIALS_ENCRYPTION_KEY: KEY } as NodeJS.ProcessEnv;
    const sealed = sealSecrets({ api_key: "secret-key" }, env);
    expect(sealed).not.toContain("secret-key");
    expect(openSecrets(sealed, env)).toEqual({ api_key: "secret-key" });
    expect(openSecrets(sealed, { LENDER_CREDENTIALS_ENCRYPTION_KEY: "b".repeat(64) } as NodeJS.ProcessEnv)).toEqual({});
    expect(openSecrets(sealed, {} as NodeJS.ProcessEnv)).toEqual({});
    const pub = publicConnection({ secrets_encrypted: sealed, secret_hints: { api_key: "ends -key" } } as any);
    expect(JSON.stringify(pub)).not.toContain(sealed);
    expect(pub.secrets_saved).toEqual(["api_key"]);
  });
  it("uses AES-256-GCM with a 32-byte key in hex or base64, and refuses tampering", () => {
    const b64 = { LENDER_CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as NodeJS.ProcessEnv;
    expect(credentialsKeyConfigured(b64)).toBe(true);
    expect(credentialsKeyConfigured({ LENDER_CREDENTIALS_ENCRYPTION_KEY: "too-short" } as NodeJS.ProcessEnv)).toBe(false);
    expect(() => seal("x", {} as NodeJS.ProcessEnv)).toThrow(/lender_credentials_key_missing/);
    const a = seal("hello", b64);
    const b = seal("hello", b64);
    expect(a).not.toBe(b); // a fresh IV every time
    expect(open(a, b64)).toBe("hello");
    const raw = Buffer.from(a.slice(3), "base64url");
    raw[raw.length - 1] ^= 1;
    expect(open(`v1.${raw.toString("base64url")}`, b64)).toBeNull();
  });
  it("backs off retries", () => {
    expect([1, 2, 3, 10].map(retryDelayMinutes)).toEqual([2, 4, 8, 120]);
  });
});

describe("applyRemoteUpdate", () => {
  beforeEach(() => queryMock.mockReset());
  it("logs the status change, adds the offer and conditions, notifies the owner and schedules the next poll", async () => {
    const db = { query: vi.fn(answerBySql([
      [/SELECT owner_user_id/, { rows: [{ owner: "22222222-2222-2222-2222-222222222222" }] }],
      [/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Offer" }] }],
      [/FROM offers WHERE lender_id/, { rows: [] }],
      [/INSERT INTO lender_api_conditions/, { rows: [{ inserted: true, status: "open" }] }],
    ])) };
    const out = await applyRemoteUpdate(db as any, {
      submission: { id: "s1", application_id: "app-1", lender_id: "11111111-1111-1111-1111-111111111111", connector: "generic_rest", external_id: "D-9", lender_status: "received", bucket: "submitted" },
      lenderName: "Test Lender", source: "poll", adminStatusMap: {}, connectorDefaults: {}, pollIntervalMinutes: 30,
      update: { externalId: "D-9", status: "Approved", offers: [{ externalId: "o1", amount: 50000, rateFactor: "1.3", term: "12m", paymentFrequency: "Weekly", expiryDate: null, status: null, notes: null }], conditions: [{ externalId: "c1", kind: "document_request", description: "Void cheque", documentType: "void_check", status: "open" }] },
    });
    expect(out).toMatchObject({ statusChanged: true, bucket: "offer", newOffers: 1, newConditions: 1 });
    expect(callsMatching(db.query, /INSERT INTO offers/)).toHaveLength(1);
    expect(callsMatching(db.query, /INSERT INTO notifications/).length).toBeGreaterThanOrEqual(3);
    const kinds = callsMatching(db.query, /INSERT INTO lender_api_events/).map((c) => (c[1] as unknown[])[4]);
    expect(kinds).toEqual(expect.arrayContaining(["status_changed", "offer_received", "condition_added"]));
    const upd = callsMatching(db.query, /UPDATE lender_api_submissions/)[0]![1] as unknown[];
    expect(upd[3]).toBe("offer");
    expect(upd[7]).toBe(false); // not terminal: keeps polling
  });

  const sub = { id: "s1", application_id: "app-1", lender_id: "11111111-1111-1111-1111-111111111111", connector: "generic_rest", external_id: "D-9", lender_status: "funded", bucket: "funded" };
  const base = { submission: sub, lenderName: "Test Lender", source: "poll" as const, adminStatusMap: {}, connectorDefaults: {}, pollIntervalMinutes: 30 };

  it("copies a lender condition into the funding conditions checklist once, then clears it when the lender does", async () => {
    let linked: string | null = null;
    const db = { query: vi.fn(answerBySql([
      [/SELECT owner_user_id/, { rows: [{ owner: "22222222-2222-2222-2222-222222222222" }] }],
      [/INSERT INTO lender_api_conditions/, () => ({ rows: [{ id: "lc1", inserted: linked === null, status: "open", funding_condition_id: linked }] })],
      [/FROM funding_conditions WHERE application_id = \$1 AND lower\(title\)/, { rows: [] }],
      [/INSERT INTO funding_conditions/, { rows: [{ id: "fc1" }] }],
      [/UPDATE lender_api_conditions SET funding_condition_id/, (_s: string, p: unknown[]) => { linked = String(p[1]); return { rows: [] }; }],
      [/UPDATE funding_conditions SET status = 'cleared'/, { rows: [{ id: "fc1" }] }],
    ])) };
    const cond = { externalId: "c1", kind: "document_request" as const, description: "Void cheque", documentType: "void_check", status: "open" as const };
    const first = await applyRemoteUpdate(db as any, { ...base, update: { externalId: "D-9", conditions: [cond] } });
    expect(first.checklistAdded).toBe(1);
    const ins = callsMatching(db.query, /INSERT INTO funding_conditions/);
    expect(ins).toHaveLength(1);
    expect(String(ins[0]![0])).toContain("'lender_api'");
    expect(ins[0]![1]).toEqual(expect.arrayContaining(["app-1", "Void cheque", true]));
    expect(linked).toBe("fc1");
    // The same condition again, now satisfied: no second checklist item, the linked one is cleared.
    await applyRemoteUpdate(db as any, { ...base, update: { externalId: "D-9", conditions: [{ ...cond, status: "satisfied" }] } });
    expect(callsMatching(db.query, /INSERT INTO funding_conditions/)).toHaveLength(1);
    expect(callsMatching(db.query, /UPDATE funding_conditions SET status = 'cleared'/)).toHaveLength(1);
  });

  it("links to a checklist item with the same title instead of duplicating it", async () => {
    const db = { query: vi.fn(answerBySql([
      [/INSERT INTO lender_api_conditions/, { rows: [{ id: "lc1", inserted: true, status: "open", funding_condition_id: null }] }],
      [/FROM funding_conditions WHERE application_id = \$1 AND lower\(title\)/, { rows: [{ id: "fc-existing" }] }],
    ])) };
    const out = await applyRemoteUpdate(db as any, { ...base, update: { externalId: "D-9", conditions: [{ externalId: "c1", kind: "condition", description: "Insurance certificate", documentType: null, status: "open" }] } });
    expect(out.checklistAdded).toBe(0);
    expect(callsMatching(db.query, /INSERT INTO funding_conditions/)).toHaveLength(0);
    expect((callsMatching(db.query, /UPDATE lender_api_conditions SET funding_condition_id/)[0]![1] as unknown[])[1]).toBe("fc-existing");
  });

  it("records a reported balance on the file's open Active Contract, once per new figure, and keeps polling funded deals daily", async () => {
    let lastBalance: { balance: string; as_of: string } | null = null;
    const db = { query: vi.fn(answerBySql([
      [/FROM active_contracts\s+WHERE application_id/, { rows: [{ id: "44444444-4444-4444-4444-444444444444" }] }],
      [/FROM active_contract_balances/, () => ({ rows: lastBalance ? [lastBalance] : [] })],
      [/INSERT INTO active_contract_balances/, (_s: string, p: unknown[]) => { lastBalance = { balance: String(p[1]), as_of: String(p[2]) }; return { rows: [{ id: "b1" }] }; }],
    ])) };
    const out = await applyRemoteUpdate(db as any, { ...base, update: { externalId: "D-9", balance: 41250.5, balanceAsOf: "2026-10-31" } });
    expect(out.balanceRecorded).toBe(true);
    const bal = callsMatching(db.query, /INSERT INTO active_contract_balances/);
    expect(bal).toHaveLength(1);
    expect(bal[0]![1]).toEqual(expect.arrayContaining(["44444444-4444-4444-4444-444444444444", 41250.5, "2026-10-31", "lender_portal"]));
    const kinds = callsMatching(db.query, /INSERT INTO lender_api_events/).map((c) => (c[1] as unknown[])[4]);
    expect(kinds).toContain("balance_reported");
    const upd = callsMatching(db.query, /UPDATE lender_api_submissions/).at(-1)![1] as unknown[];
    expect(upd[7]).toBe(false); // funded: polling continues
    expect(upd[8]).toBe("1440"); // once a day
    // The same figure again (no newer date): not recorded twice.
    const again = await applyRemoteUpdate(db as any, { ...base, update: { externalId: "D-9", balance: 41250.5 } });
    expect(again.balanceRecorded).toBe(false);
    expect(callsMatching(db.query, /INSERT INTO active_contract_balances/)).toHaveLength(1);
  });

  it("skips the balance when the file has no open Active Contract, and stops polling a declined deal", async () => {
    const db = { query: vi.fn(answerBySql([[/SELECT pipeline_state FROM applications/, { rows: [{ pipeline_state: "Off to Lender" }] }]])) };
    const out = await applyRemoteUpdate(db as any, { ...base, submission: { ...sub, lender_status: "In review", bucket: "in_review" }, update: { externalId: "D-9", status: "Declined", balance: 100 } });
    expect(out).toMatchObject({ bucket: "declined", balanceRecorded: false });
    expect(callsMatching(db.query, /INSERT INTO active_contract_balances/)).toHaveLength(0);
    const upd = callsMatching(db.query, /UPDATE lender_api_submissions/).at(-1)![1] as unknown[];
    expect(upd[7]).toBe(true);
  });
});

describe("routes", () => {
  afterEach(() => { vi.unstubAllEnvs(); queryMock.mockReset(); });

  it("the webhook refuses a wrong address secret and applies a signed update", async () => {
    vi.stubEnv("LENDER_CREDENTIALS_ENCRYPTION_KEY", KEY);
    const connId = "33333333-3333-3333-3333-333333333333";
    const sealed = sealSecrets({ webhook_url_token: "tok123", webhook_secret: "whs" });
    queryMock.mockImplementation(answerBySql([
      [/FROM lender_connections c WHERE c.id::text/, { rows: [{ id: connId, lender_id: "11111111-1111-1111-1111-111111111111", connector: "generic_rest", enabled: true, poll_interval_minutes: 30, config: { base_url: "https://api.lender.example", webhook: { signature: "hmac_sha256_hex", signature_header: "X-Sig", external_id_path: "deal_id", status_path: "state" } }, secrets_encrypted: sealed, secret_hints: {}, status_map: {} }] }],
      [/FROM lender_api_submissions s JOIN lenders l/, { rows: [{ id: "s1", application_id: "app-1", lender_id: "11111111-1111-1111-1111-111111111111", connector: "generic_rest", external_id: "D-9", lender_status: null, bucket: null, connection_id: connId, lender_name: "Test Lender" }] }],
    ]));
    const router = (await import("../../routes/lenderWebhooks.js")).default;
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    app.use("/api/lender-webhooks", router);
    const payload = JSON.stringify({ deal_id: "D-9", state: "Funded" });
    const bad = await request(app).post(`/api/lender-webhooks/${connId}/wrong`).set("Content-Type", "application/json").send(payload);
    expect(bad.status).toBe(401);
    const unsigned = await request(app).post(`/api/lender-webhooks/${connId}/tok123`).set("Content-Type", "application/json").send(payload);
    expect(unsigned.status).toBe(401);
    const sig = createHmac("sha256", "whs").update(payload).digest("hex");
    const ok = await request(app).post(`/api/lender-webhooks/${connId}/tok123`).set("Content-Type", "application/json").set("X-Sig", sig).send(payload);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, applied: 1 });
    expect(callsMatching(queryMock, /INSERT INTO lender_api_events/).length).toBeGreaterThan(0);
    expect(OUTBOUND_MESSAGE_ACK).toContain("<Ack>true</Ack>");
  });
});
