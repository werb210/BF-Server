// BF_SERVER_v872_KYC - ID verification: the Entrust IDV (Onfido) adapter, webhook signature, the service over a database
// mock that answers by SQL content (no personal data in logs or plain columns), and the fraud check 8 signal.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { applicantBody, mapRunStatus, onfidoBase, onfidoProvider, reasonsFor, verifyOnfidoSignature, type BinaryFetch } from "../providers/onfido.js";
import { manualProvider, resolveProvider } from "../providers/index.js";
import { handleWebhook, parseSettingsPatch, requestVerification, staffDecision, submitManualUpload } from "../service.js";
import { evaluateIdentity, verificationReasons } from "../../fraud/checks/identity.js";
import { maskNumber } from "../crypto.js";

const ENV = { ONFIDO_API_TOKEN: "api_sandbox.tok", ONFIDO_WORKFLOW_ID: "wf-1", ONFIDO_WEBHOOK_TOKEN: "whsec", ONFIDO_REGION: "ca", NODE_ENV: "test", JWT_SECRET: "unit-test-secret-123" } as any;
process.env.JWT_SECRET ||= "unit-test-secret-123";
process.env.BF_SSN_ENCRYPTION_FALLBACK = "1"; // AES-GCM, no pgcrypto round trip in the mock

type Call = { url: string; init: any };
function fakeFetch(routes: Record<string, any>, calls: Call[] = []): BinaryFetch {
  return (async (url: string, init?: any) => {
    calls.push({ url, init });
    const path = url.replace(/^https:\/\/api\.[a-z]+\.onfido\.com\/v3\.6/, "");
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const body = key ? routes[key] : undefined;
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(`img:${path}`).buffer,
      headers: { get: () => "image/jpeg" },
    };
  }) as BinaryFetch;
}

const RUN_DONE = {
  "/workflow_runs/run-1": { id: "run-1", status: "approved", applicant_id: "appl-1", reasons: [] },
  "/checks": { checks: [{ id: "chk-1", report_ids: ["rep-doc", "rep-face", "rep-ide"] }] },
  "/reports/rep-doc": { name: "document", result: "clear", properties: { first_name: "Jane", last_name: "Doe", date_of_birth: "1980-04-21", document_numbers: [{ type: "document_number", value: "D1234-56789" }], issuing_country: "CAN", document_type: "driving_licence", date_of_expiry: "2030-01-01" } },
  "/reports/rep-face": { name: "facial_similarity_motion", result: "clear" },
  "/reports/rep-ide": { name: "identity_enhanced", result: "consider", sub_result: "caution" },
  "/documents?": { documents: [{ id: "doc-f", side: "front", file_type: "jpg" }, { id: "doc-b", side: "back", file_type: "jpg" }] },
  "/documents/doc-f/download": {},
  "/documents/doc-b/download": {},
  "/live_photos?": { live_photos: [{ id: "lp-1" }] },
  "/live_photos/lp-1/download": {},
};

/** A tiny in-memory stand-in for the tables the service touches, answering by SQL content. */
function memDb() {
  const state = {
    settings: { provider: null as string | null, wizard_step: false, wizard_people: "applicant" },
    verifications: [] as any[],
    events: new Set<string>(),
    documents: [] as any[],
    messages: 0,
    fraudRuns: 0,
  };
  const db = {
    state,
    query: vi.fn(async (sql: string, p: any[] = []) => {
      const s = sql.replace(/\s+/g, " ");
      if (s.includes("FROM kyc_settings")) return { rows: [state.settings] };
      if (s.startsWith("SELECT id::text AS id FROM applications")) return { rows: p[0] === "app-1" ? [{ id: "app-1" }] : [] };
      if (s.includes("FROM (SELECT a.contact_id::text AS contact_id")) return { rows: [{ contact_id: "c-1", role: "applicant", name: "Jane Doe", phone: "5875550100", email: "j@x.ca" }, { contact_id: "c-2", role: "guarantor", name: "Gus G", phone: null, email: null }] };
      if (s.includes("FROM kyc_verifications v WHERE v.application_id = $1 AND v.contact_id = $2")) return { rows: state.verifications.filter((v) => v.application_id === p[0] && v.contact_id === p[1] && ["requested", "in_progress", "processing"].includes(v.status)) };
      if (s.startsWith("INSERT INTO kyc_verifications")) {
        state.verifications.push({ id: p[0], application_id: p[1], contact_id: p[2], person_role: p[3], provider: p[4], status: "requested", reasons: [], checks: {}, document_ids: [], requested_via: p[6] });
        return { rows: [{ id: p[0] }] };
      }
      if (s.includes("FROM kyc_verifications v WHERE v.id::text = $1")) return { rows: state.verifications.filter((v) => v.id === p[0]) };
      if (s.includes("FROM kyc_verifications v WHERE v.provider = $1 AND v.vendor_session_id = $2")) return { rows: state.verifications.filter((v) => v.provider === p[0] && v.vendor_session_id === p[1]) };
      if (s.startsWith("INSERT INTO kyc_webhook_events")) {
        const k = `${p[0]}:${p[1]}`;
        if (state.events.has(k)) return { rows: [] };
        state.events.add(k);
        return { rows: [{ event_key: p[1] }] };
      }
      if (s.startsWith("UPDATE kyc_webhook_events")) return { rows: [] };
      if (s.startsWith("UPDATE kyc_verifications SET status = $2, reasons = $3::jsonb, checks")) {
        const v = state.verifications.find((x) => x.id === p[0]);
        Object.assign(v, { status: p[1], reasons: JSON.parse(p[2]), checks: JSON.parse(p[3]), pii_enc: p[4] ?? v.pii_enc, decision_source: p[5] ? "vendor" : v.decision_source });
        return { rows: [] };
      }
      if (s.startsWith("UPDATE kyc_verifications SET document_ids = $2")) { state.verifications.find((x) => x.id === p[0]).document_ids = p[1]; return { rows: [] }; }
      if (s.startsWith("UPDATE kyc_verifications SET status = 'review', document_ids")) {
        const v = state.verifications.find((x) => x.id === p[0]);
        Object.assign(v, { status: "review", document_ids: [...v.document_ids, ...p[1]], reasons: JSON.parse(p[2]) });
        return { rows: [] };
      }
      if (s.startsWith("UPDATE kyc_verifications SET status = $2, decision_source = 'staff'")) {
        Object.assign(state.verifications.find((x) => x.id === p[0]), { status: p[1], decision_source: "staff", reasons: JSON.parse(p[4]) });
        return { rows: [] };
      }
      if (s.startsWith("INSERT INTO documents")) { state.documents.push({ id: p[0], application_id: p[1], filename: p[2], category: p[4], uploaded_by: "system" }); return { rows: [] }; }
      if (s.startsWith("INSERT INTO document_versions")) return { rows: [] };
      if (s.includes("fraud_queue") || s.includes("fraud_run")) { state.fraudRuns += 1; return { rows: [] }; }
      throw new Error(`unexpected SQL in test: ${s.slice(0, 120)}`);
    }),
  };
  return db;
}

const storage = { put: vi.fn(async (x: any) => ({ blobName: `blob/${x.filename}`, url: `https://blob/${x.filename}`, hash: "h", sizeBytes: x.buffer.length })) };

describe("Entrust IDV (Onfido) adapter", () => {
  it("defaults to the Canadian region and maps run statuses", () => {
    expect(onfidoBase({} as any)).toBe("https://api.ca.onfido.com/v3.6");
    expect(onfidoBase({ ONFIDO_REGION: "us" } as any)).toBe("https://api.us.onfido.com/v3.6");
    expect(onfidoBase({ ONFIDO_REGION: "mars" } as any)).toBe("https://api.ca.onfido.com/v3.6");
    expect(mapRunStatus("approved")).toBe("approved");
    expect(mapRunStatus("awaiting_input")).toBe("in_progress");
    expect(mapRunStatus("abandoned")).toBe("expired");
    expect(mapRunStatus("review")).toBe("review");
  });

  it("verifies X-SHA2-Signature over the exact raw body", () => {
    const raw = Buffer.from('{"payload":{"resource_type":"workflow_run","action":"workflow_run.completed","object":{"id":"run-1"}}}');
    const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
    expect(verifyOnfidoSignature(raw, sig, "whsec")).toBe(true);
    expect(verifyOnfidoSignature(Buffer.from(raw.toString() + " "), sig, "whsec")).toBe(false);
    expect(verifyOnfidoSignature(raw, sig, "other")).toBe(false);
    expect(verifyOnfidoSignature(raw, "nope", "whsec")).toBe(false);
    expect(verifyOnfidoSignature(raw, sig, "")).toBe(false);
  });

  it("sends only name and email unless the date of birth and a full address are known", () => {
    expect(applicantBody({ firstName: "Jane", lastName: "Doe", email: "j@x.ca", phone: null, dob: null, address: null })).toEqual({ first_name: "Jane", last_name: "Doe", email: "j@x.ca" });
    const full = applicantBody({ firstName: "Jane", lastName: "Doe", email: null, phone: null, dob: "1980-04-21", address: { street: "1 Main St", city: "Edmonton", state: "ab", postcode: "T5J 0N3", country: "Canada" } });
    expect(full).toMatchObject({ dob: "1980-04-21", address: { country: "CAN", state: "AB", town: "Edmonton" } });
  });

  it("creates an applicant and a workflow run with a hosted link, using the API token", async () => {
    const calls: Call[] = [];
    const p = onfidoProvider(ENV, fakeFetch({ "/applicants": { id: "appl-1" }, "/workflow_runs": { id: "run-1", link: { url: "https://ca.onfido.app/l/abc", expires_at: "2030-01-01T00:00:00Z" } } }, calls));
    expect(p.configured()).toBe(true);
    const s = await p.createSession!({ verificationId: "v1", person: { firstName: "Jane", lastName: "Doe", email: null, phone: null, dob: null, address: null }, redirectUrl: "https://client.example/verify/app-1" });
    expect(s).toMatchObject({ ok: true, vendorApplicantId: "appl-1", vendorSessionId: "run-1", url: "https://ca.onfido.app/l/abc" });
    expect(calls[0]!.url).toBe("https://api.ca.onfido.com/v3.6/applicants");
    expect(calls[0]!.init.headers.Authorization).toBe("Token token=api_sandbox.tok");
    expect(JSON.parse(calls[1]!.init.body)).toMatchObject({ workflow_id: "wf-1", applicant_id: "appl-1", link: { completed_redirect_url: "https://client.example/verify/app-1" } });
  });

  it("is not set up without all three settings, and never reaches the network in tests without a fetch", () => {
    expect(onfidoProvider({ ...ENV, ONFIDO_WEBHOOK_TOKEN: "" }, fakeFetch({})).configured()).toBe(false);
    expect(onfidoProvider(ENV).configured()).toBe(false);
  });

  it("reads reports into non-personal check results and personal details separately", async () => {
    const p = onfidoProvider(ENV, fakeFetch(RUN_DONE));
    const r = await p.fetchResult!("run-1", "appl-1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.status).toBe("approved");
    expect(r.result.checks).toEqual({ document: "clear", liveness: "clear", identity_record: "caution" });
    expect(r.result.pii).toMatchObject({ document_number: "D1234-56789", date_of_birth: "1980-04-21" });
    expect(JSON.stringify(r.result.reasons)).not.toContain("D1234");
    expect(r.result.reasons.some((x) => x.code === "identity_record_caution" && x.severity === "amber")).toBe(true);
    expect(r.result.media.map((m) => m.kind)).toEqual(["document_front", "document_back", "selfie"]);
  });

  it("plain-English reasons for declines and reviews", () => {
    expect(reasonsFor("declined", { document: "consider" }, ["document_expired"]).some((r) => r.severity === "red")).toBe(true);
    expect(reasonsFor("review", {}, []).map((r) => r.code)).toContain("review");
  });
});

describe("KYC service", () => {
  const providers = () => ({ onfido: onfidoProvider(ENV, fakeFetch(RUN_DONE)), manual: manualProvider() });

  it("automatic provider choice: Entrust IDV when it is set up, else manual review", () => {
    expect(resolveProvider(null, providers()).key).toBe("onfido");
    expect(resolveProvider(null, { onfido: onfidoProvider({} as any), manual: manualProvider() }).key).toBe("manual");
    expect(resolveProvider("manual", providers()).key).toBe("manual");
  });

  it("settings patches are validated", () => {
    expect(parseSettingsPatch({ provider: "auto", wizard_step: true })).toEqual({ ok: true, patch: { provider: null, wizard_step: true } });
    expect(parseSettingsPatch({ provider: "persona" }).ok).toBe(false);
    expect(parseSettingsPatch({ wizard_people: "everyone" }).ok).toBe(false);
  });

  it("a request goes to the applicant, tells them once, and is not duplicated while open", async () => {
    const db = memDb();
    const notify = vi.fn(async () => {});
    const r = await requestVerification({ applicationId: "app-1", via: "staff", requestedBy: "u1" }, { db: db as any, providers: providers(), notify });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(db.state.verifications[0]).toMatchObject({ contact_id: "c-1", provider: "onfido", person_role: "applicant" });
    const again = await requestVerification({ applicationId: "app-1", via: "staff", requestedBy: "u1" }, { db: db as any, providers: providers(), notify });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(notify).toHaveBeenCalledTimes(1);
    const g = await requestVerification({ applicationId: "app-1", contactId: "c-2", via: "staff", requestedBy: "u1" }, { db: db as any, providers: providers(), notify });
    expect(g).toMatchObject({ ok: true, created: true });
    expect(db.state.verifications[1].person_role).toBe("guarantor");
    expect(await requestVerification({ applicationId: "app-1", contactId: "c-9", via: "staff", requestedBy: null }, { db: db as any, providers: providers(), notify })).toMatchObject({ ok: false, error: "person_not_on_file" });
  });

  it("refuses to send when the chosen vendor is not set up", async () => {
    const db = memDb();
    db.state.settings.provider = "onfido";
    const r = await requestVerification({ applicationId: "app-1", via: "staff", requestedBy: null }, { db: db as any, providers: { onfido: onfidoProvider({} as any), manual: manualProvider() }, notify: async () => {} });
    expect(r).toMatchObject({ ok: false, error: "provider_not_configured" });
  });

  it("webhook: bad signature 401; a good one stores the result encrypted and the images as documents; retries are no-ops", async () => {
    const db = memDb();
    db.state.verifications.push({ id: "11111111-1111-1111-1111-111111111111", application_id: "app-1", contact_id: "c-1", person_role: "applicant", provider: "onfido", status: "in_progress", reasons: [], checks: {}, document_ids: [], vendor_session_id: "run-1", vendor_applicant_id: "appl-1" });
    const body = { payload: { resource_type: "workflow_run", action: "workflow_run.completed", object: { id: "run-1", status: "approved" } } };
    const raw = Buffer.from(JSON.stringify(body));
    const deps = { db: db as any, providers: providers(), storage };
    expect(await handleWebhook("onfido", raw, { "x-sha2-signature": "0".repeat(64) }, body, deps)).toMatchObject({ status: 401, outcome: "bad_signature" });
    const sig = createHmac("sha256", "whsec").update(raw).digest("hex");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, deps)).toMatchObject({ status: 200, outcome: "processed" });
    const v = db.state.verifications[0];
    expect(v.status).toBe("approved");
    expect(v.checks).toMatchObject({ document: "clear" });
    expect(Buffer.isBuffer(v.pii_enc)).toBe(true);
    expect(v.pii_enc.toString("utf8")).not.toContain("D1234");
    expect(v.document_ids).toHaveLength(3);
    expect(db.state.documents.every((d) => d.category === "Identity verification" && d.application_id === "app-1")).toBe(true);
    expect(await handleWebhook("onfido", raw, { "x-sha2-signature": sig }, body, deps)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(db.state.verifications[0].status).toBe("approved");
    // no ID number ever reaches the logs
    for (const c of warn.mock.calls) expect(JSON.stringify(c)).not.toContain("D1234");
    warn.mockRestore();
    // a run this server did not start
    const other = { payload: { resource_type: "workflow_run", action: "workflow_run.completed", object: { id: "run-zzz" } } };
    const raw2 = Buffer.from(JSON.stringify(other));
    expect(await handleWebhook("onfido", raw2, { "x-sha2-signature": createHmac("sha256", "whsec").update(raw2).digest("hex") }, other, deps)).toMatchObject({ outcome: "unknown_session" });
  });

  it("manual review: ID and selfie required, then staff decide", async () => {
    const db = memDb();
    db.state.verifications.push({ id: "22222222-2222-2222-2222-222222222222", application_id: "app-1", contact_id: "c-1", person_role: "applicant", provider: "manual", status: "requested", reasons: [], checks: {}, document_ids: [] });
    const deps = { db: db as any, providers: providers(), storage };
    const img = { buffer: Buffer.from("jpg"), contentType: "image/jpeg", filename: "a.jpg" };
    expect(await submitManualUpload("22222222-2222-2222-2222-222222222222", [{ kind: "document_front", ...img }], deps)).toMatchObject({ ok: false, error: "id_and_selfie_required" });
    expect(await submitManualUpload("22222222-2222-2222-2222-222222222222", [{ kind: "document_front", ...img }, { kind: "selfie", ...img, contentType: "text/html" }], deps)).toMatchObject({ ok: false, error: "unsupported_file_type" });
    expect(await submitManualUpload("22222222-2222-2222-2222-222222222222", [{ kind: "document_front", ...img }, { kind: "selfie", ...img }], deps)).toEqual({ ok: true, status: "review" });
    expect(db.state.fraudRuns).toBeGreaterThan(0); // the fraud checks run again with the new signal
    const d = await staffDecision("22222222-2222-2222-2222-222222222222", "approved", "Photo matches the licence", "u1", deps);
    expect(d.ok).toBe(true);
    expect(db.state.verifications[0]).toMatchObject({ status: "approved", decision_source: "staff" });
  });
});

describe("fraud check 8 reads ID verifications", () => {
  it("declined = red, review = amber, approved = info; works before any ID is uploaded", () => {
    expect(verificationReasons([{ role: "applicant", status: "declined", provider: "onfido", decidedBy: "vendor" }])[0]).toMatchObject({ severity: "red" });
    const r = evaluateIdentity({ idDocs: [], applicantName: "Jane", applicantDob: null, ownerNames: [], reusedElsewhere: 0, idvConfigured: true, verifications: [{ role: "guarantor", status: "review", provider: "onfido", decidedBy: "vendor" }] });
    expect(r.status).toBe("amber");
    const ok = evaluateIdentity({ idDocs: [], applicantName: "Jane", applicantDob: null, ownerNames: [], reusedElsewhere: 0, idvConfigured: true, verifications: [{ role: "applicant", status: "approved", provider: "onfido", decidedBy: "vendor" }] });
    expect(ok.status).toBe("green");
    expect(evaluateIdentity({ idDocs: [], applicantName: null, applicantDob: null, ownerNames: [], reusedElsewhere: 0, idvConfigured: true, verifications: [{ role: "applicant", status: "cancelled", provider: "manual", decidedBy: null }] }).status).toBe("not_applicable");
  });
});

describe("masking", () => {
  it("staff see the last four characters of an ID number unless an Admin reveals it", () => {
    expect(maskNumber("D1234-56789")).toBe("*******6789");
    expect(maskNumber("12")).toBe("**");
    expect(maskNumber("")).toBeNull();
  });
});
