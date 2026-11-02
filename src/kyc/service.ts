// BF_SERVER_v872_KYC - ID and address verification of applicants and guarantors (ported from KS-server #50 without the
// plan gate or the usage allowance).
//
//   request   staff (or the client app's optional wizard step) ask one person on a file to verify; the client gets a
//             "Verify your identity" button in the client app and a text or push.
//   start     the applicant opens it in the client app: a hosted vendor link (onfido), or the upload form (manual).
//   webhook   the vendor says a run changed; we fetch the result with our own token, store status, reasons and the
//             non-personal check results, the ID details encrypted, and the ID images and selfie as documents on the
//             application (retention and legal holds apply to them like any upload).
//   decide    staff approve or decline a verification the vendor sent to review, or a manual one.
// Every change queues the fraud checks again: check 8 (ID checks) reads these results.
//
// Privacy: ID numbers, dates of birth and names read from the ID are never logged and never stored in plain columns.
// Logs carry the verification id, the status and an error code only.
import { createHash, randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { brandName, clientUrl } from "../settingsPack/boreal.js";
import { getStorage } from "../lib/storage/index.js";
import type { StorageBackend } from "../lib/storage/index.js";
import { enqueueFraudRun } from "../fraud/store.js";
import type { Q } from "../settingsPack/common.js";
import { decryptJson, encryptJson, maskNumber } from "./crypto.js";
import { isProviderKey, kycProviders, resolveProvider } from "./providers/index.js";
import {
  FINAL_STATUSES, OPEN_STATUSES, type KycMedia, type KycPerson, type KycPii, type KycProvider, type KycProviderKey,
  type KycReason, type KycStatus,
} from "./types.js";

export type Db = Q;
const defaultDb = (): Db => pool as unknown as Db;

export type KycSettings = {
  provider: KycProviderKey | null;
  wizard_step: boolean;
  wizard_people: "applicant" | "applicant_and_guarantors";
  updated_at: string | null;
};

export type KycDeps = {
  db?: Db;
  providers?: Record<KycProviderKey, KycProvider>;
  storage?: Pick<StorageBackend, "put">;
  /** Posts the client-app button and sends the text/push. Tests replace it. */
  notify?: (n: { applicationId: string; contactId: string | null; phone: string | null; verificationId: string }) => Promise<void>;
  now?: () => Date;
};

const providersOf = (d: KycDeps) => d.providers ?? kycProviders();
const dbOf = (d: KycDeps) => d.db ?? defaultDb();

// ------------------------------------------------------------------------------------------------ settings
export async function getKycSettings(db: Db = defaultDb()): Promise<KycSettings> {
  const r = await db.query(`SELECT provider, wizard_step, wizard_people, updated_at FROM kyc_settings WHERE id = 1`);
  const row = r.rows[0] ?? {};
  return {
    provider: isProviderKey(row.provider) ? row.provider : null,
    wizard_step: row.wizard_step === true,
    wizard_people: row.wizard_people === "applicant_and_guarantors" ? "applicant_and_guarantors" : "applicant",
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export type SettingsPatch = { provider?: KycProviderKey | null; wizard_step?: boolean; wizard_people?: KycSettings["wizard_people"] };

export function parseSettingsPatch(body: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ("provider" in b) {
    if (b.provider === null || b.provider === "auto") patch.provider = null;
    else if (isProviderKey(b.provider)) patch.provider = b.provider;
    else return { ok: false, error: "provider must be auto, onfido or manual" };
  }
  if ("wizard_step" in b) {
    if (typeof b.wizard_step !== "boolean") return { ok: false, error: "wizard_step must be true or false" };
    patch.wizard_step = b.wizard_step;
  }
  if ("wizard_people" in b) {
    if (b.wizard_people !== "applicant" && b.wizard_people !== "applicant_and_guarantors") return { ok: false, error: "wizard_people must be applicant or applicant_and_guarantors" };
    patch.wizard_people = b.wizard_people;
  }
  return { ok: true, patch };
}

export async function saveKycSettings(db: Db, patch: SettingsPatch, userId: string | null): Promise<KycSettings> {
  const cur = await getKycSettings(db);
  const next = { ...cur, ...patch };
  await db.query(
    `INSERT INTO kyc_settings (id, provider, wizard_step, wizard_people, updated_at, updated_by) VALUES (1, $1, $2, $3, now(), $4)
     ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, wizard_step = EXCLUDED.wizard_step, wizard_people = EXCLUDED.wizard_people,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [next.provider, next.wizard_step, next.wizard_people, userId],
  );
  return getKycSettings(db);
}

export async function activeProvider(deps: KycDeps = {}): Promise<KycProvider> {
  const s = await getKycSettings(dbOf(deps));
  return resolveProvider(s.provider, providersOf(deps));
}

// ------------------------------------------------------------------------------------------------ people on a file
export type FilePerson = { contact_id: string; role: string; name: string; phone: string | null; email: string | null };

export async function peopleOnFile(db: Db, applicationId: string): Promise<FilePerson[]> {
  const r = await db.query(
    `SELECT c.id::text AS contact_id, x.role,
            COALESCE(NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.name, c.email, 'Unnamed') AS name, c.phone, c.email
       FROM (SELECT a.contact_id::text AS contact_id, 'applicant'::text AS role, 0 AS rank FROM applications a
              WHERE a.id::text = $1 AND a.contact_id IS NOT NULL
             UNION ALL
             SELECT ac.contact_id::text, ac.role, CASE ac.role WHEN 'applicant' THEN 0 WHEN 'partner' THEN 1 WHEN 'guarantor' THEN 2 ELSE 3 END
               FROM application_contacts ac WHERE ac.application_id::text = $1) x
       JOIN contacts c ON c.id::text = x.contact_id
      ORDER BY x.rank, name`,
    [applicationId],
  );
  const seen = new Set<string>();
  const out: FilePerson[] = [];
  for (const row of r.rows) {
    if (seen.has(row.contact_id)) continue;
    seen.add(row.contact_id);
    out.push({ contact_id: row.contact_id, role: String(row.role ?? "applicant"), name: String(row.name), phone: row.phone ?? null, email: row.email ?? null });
  }
  return out;
}

async function personFor(db: Db, contactId: string | null): Promise<KycPerson> {
  if (!contactId) return { firstName: null, lastName: null, email: null, phone: null, dob: null, address: null };
  const r = await db.query(
    `SELECT first_name, last_name, name, email, phone, dob::text AS dob, address_street, address_city, address_state, address_zip, address_country
       FROM contacts WHERE id::text = $1 LIMIT 1`,
    [contactId],
  );
  const c = r.rows[0] ?? {};
  const parts = String(c.name ?? "").trim().split(/\s+/);
  return {
    firstName: c.first_name ?? (parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0] || null),
    lastName: c.last_name ?? (parts.length > 1 ? parts[parts.length - 1]! : null),
    email: c.email ?? null,
    phone: c.phone ?? null,
    dob: c.dob ? String(c.dob).slice(0, 10) : null,
    address: c.address_street || c.address_city
      ? { street: c.address_street ?? null, city: c.address_city ?? null, state: c.address_state ?? null, postcode: c.address_zip ?? null, country: c.address_country ?? null }
      : null,
  };
}

// ------------------------------------------------------------------------------------------------ views
const COLUMNS = `v.id::text AS id, v.application_id, v.contact_id, v.person_role, v.provider, v.status, v.decision_source, v.reasons, v.checks,
  v.vendor_applicant_id, v.vendor_session_id, v.session_url_enc, v.session_expires_at, v.pii_enc, v.document_ids, v.requested_by,
  v.requested_via, v.requested_at, v.started_at, v.completed_at, v.reviewed_by, v.reviewed_at, v.review_note, v.updated_at`;

export type KycRow = Record<string, any>;

export async function getVerification(db: Db, id: string): Promise<KycRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`SELECT ${COLUMNS} FROM kyc_verifications v WHERE v.id::text = $1 LIMIT 1`, [id]);
  return r.rows[0] ?? null;
}

export async function listForApplication(db: Db, applicationId: string): Promise<KycRow[]> {
  const r = await db.query(
    `SELECT ${COLUMNS}, COALESCE(NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), ''), c.name, c.email) AS person_name
       FROM kyc_verifications v LEFT JOIN contacts c ON c.id::text = v.contact_id
      WHERE v.application_id = $1 ORDER BY v.requested_at DESC LIMIT 50`,
    [applicationId],
  );
  return r.rows;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const arr = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return []; } })() : []);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : typeof v === "string" ? (() => { try { return JSON.parse(v); } catch { return {}; } })() : {});

/** What staff see: status, reasons, check results, document ids. No personal data from the ID. */
export function staffView(r: KycRow) {
  return {
    id: r.id, application_id: r.application_id, contact_id: r.contact_id ?? null, person_name: r.person_name ?? null, person_role: r.person_role,
    provider: r.provider, status: r.status as KycStatus, decision_source: r.decision_source ?? null,
    reasons: arr(r.reasons) as KycReason[], checks: obj(r.checks) as Record<string, string>,
    document_ids: Array.isArray(r.document_ids) ? r.document_ids : [], has_id_details: Boolean(r.pii_enc),
    requested_via: r.requested_via, requested_at: iso(r.requested_at), started_at: iso(r.started_at), completed_at: iso(r.completed_at),
    reviewed_by: r.reviewed_by ?? null, reviewed_at: iso(r.reviewed_at), review_note: r.review_note ?? null,
  };
}

/** What the applicant sees about their own verification. */
export function clientView(r: KycRow, provider: KycProvider | undefined) {
  return {
    id: r.id, application_id: r.application_id, status: r.status as KycStatus, mode: provider?.hosted ? "hosted" : "upload",
    requested_at: iso(r.requested_at), completed_at: iso(r.completed_at),
  };
}

/** The ID details for a staff reveal: the document number masked unless full=true. */
export async function idDetails(r: KycRow, full: boolean, db: Db = defaultDb()): Promise<KycPii | null> {
  const pii = await decryptJson<KycPii>(db as any, r.pii_enc);
  if (!pii) return null;
  return full ? pii : { ...pii, document_number: maskNumber(pii.document_number) };
}

// ------------------------------------------------------------------------------------------------ request
export type RequestInput = { applicationId: string; contactId?: string | null; via: "staff" | "wizard"; requestedBy: string | null };
export type RequestResult =
  | { ok: true; created: boolean; verification: KycRow }
  | { ok: false; status: number; error: string };

export async function requestVerification(input: RequestInput, deps: KycDeps = {}): Promise<RequestResult> {
  const db = dbOf(deps);
  const app = (await db.query(`SELECT id::text AS id FROM applications WHERE id::text = $1 LIMIT 1`, [input.applicationId])).rows[0];
  if (!app) return { ok: false, status: 404, error: "not_found" };
  const people = await peopleOnFile(db, app.id);
  const person = input.contactId ? people.find((p) => p.contact_id === input.contactId) : people[0];
  if (!person) return { ok: false, status: input.contactId ? 400 : 409, error: input.contactId ? "person_not_on_file" : "no_applicant_on_file" };
  const open = await db.query(
    `SELECT ${COLUMNS} FROM kyc_verifications v WHERE v.application_id = $1 AND v.contact_id = $2
        AND v.status IN ('requested', 'in_progress', 'processing') ORDER BY v.requested_at DESC LIMIT 1`,
    [app.id, person.contact_id],
  );
  if (open.rows[0]) return { ok: true, created: false, verification: open.rows[0] };
  const provider = await activeProvider(deps);
  if (!provider.configured()) return { ok: false, status: 409, error: "provider_not_configured" };
  const id = randomUUID();
  const ins = await db.query(
    `INSERT INTO kyc_verifications (id, application_id, contact_id, person_role, provider, status, requested_by, requested_via)
     VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7) RETURNING id::text AS id`,
    [id, app.id, person.contact_id, person.role === "guarantor" || person.role === "partner" ? "guarantor" : "applicant", provider.key, input.requestedBy, input.via],
  );
  const row = await getVerification(db, String(ins.rows[0]?.id ?? id));
  const notify = deps.notify ?? defaultNotify;
  try {
    await notify({ applicationId: app.id, contactId: person.contact_id, phone: person.phone, verificationId: id });
  } catch (err) {
    console.warn("[kyc] could not tell the applicant", { verificationId: id, message: (err as Error)?.message });
  }
  return { ok: true, created: true, verification: row ?? { id, application_id: app.id, status: "requested" } };
}

/** The client-app button (cta_action id_verify) and one text or push. */
async function defaultNotify(n: { applicationId: string; contactId: string | null; phone: string | null; verificationId: string }): Promise<void> {
  const brand = brandName();
  await pool.query(
    `INSERT INTO communications_messages (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
     VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, $2::uuid,
       COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
       $3, $4, 'Verify your identity', 'id_verify', now())`,
    [n.applicationId, n.contactId, "Please verify your identity: a photo of your government ID and a quick selfie. It takes about two minutes.", brand],
  );
  if (!n.phone) return;
  const { notifyClient } = await import("../services/notifications/notifyClient.js");
  await notifyClient({
    phone: n.phone, applicationId: n.applicationId, kind: "id_verification", categoryId: "APPLICATION_UPDATE",
    sms: `${brand}: please verify your identity for your application. Open your application to start: ${clientUrl()}/verify/${n.applicationId}`,
    title: "Verify your identity", body: "A photo of your ID and a quick selfie. About two minutes.",
    url: `${clientUrl()}/verify/${n.applicationId}`,
  });
}

/** The wizard step: open a request for the applicant (and guarantors when set) if none is open. */
export async function wizardRequests(applicationId: string, deps: KycDeps = {}): Promise<KycRow[]> {
  const db = dbOf(deps);
  const s = await getKycSettings(db);
  if (!s.wizard_step) return [];
  const people = await peopleOnFile(db, applicationId);
  const who = s.wizard_people === "applicant_and_guarantors" ? people.filter((p, i) => i === 0 || p.role === "guarantor" || p.role === "partner") : people.slice(0, 1);
  const out: KycRow[] = [];
  for (const p of who) {
    const done = await db.query(
      `SELECT 1 FROM kyc_verifications WHERE application_id = $1 AND contact_id = $2 AND status IN ('approved', 'review') LIMIT 1`,
      [applicationId, p.contact_id],
    );
    if (done.rows.length) continue;
    const r = await requestVerification({ applicationId, contactId: p.contact_id, via: "wizard", requestedBy: null }, { ...deps, notify: deps.notify ?? (async () => {}) });
    if (r.ok) out.push(r.verification);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ start (client)
export type StartResult =
  | { ok: true; mode: "hosted"; url: string }
  | { ok: true; mode: "upload" }
  | { ok: true; mode: "done"; status: KycStatus }
  | { ok: false; status: number; error: string };

export async function startSession(id: string, deps: KycDeps = {}): Promise<StartResult> {
  const db = dbOf(deps);
  const now = deps.now?.() ?? new Date();
  const v = await getVerification(db, id);
  if (!v) return { ok: false, status: 404, error: "not_found" };
  if (!OPEN_STATUSES.has(v.status)) return { ok: true, mode: "done", status: v.status };
  const provider = providersOf(deps)[v.provider as KycProviderKey];
  if (!provider) return { ok: false, status: 409, error: "provider_not_available" };
  if (!provider.hosted) return { ok: true, mode: "upload" };
  if (!provider.configured() || !provider.createSession) return { ok: false, status: 409, error: "provider_not_configured" };
  if (v.session_url_enc && v.session_expires_at && new Date(v.session_expires_at).getTime() > now.getTime() + 5 * 60_000) {
    const saved = await decryptJson<{ url: string }>(db as any, v.session_url_enc);
    if (saved?.url) return { ok: true, mode: "hosted", url: saved.url };
  }
  const s = await provider.createSession({
    verificationId: v.id,
    person: await personFor(db, v.contact_id),
    redirectUrl: `${clientUrl()}/verify/${encodeURIComponent(v.application_id)}?done=${encodeURIComponent(v.id)}`,
  });
  if (!s.ok) {
    console.warn("[kyc] vendor session failed", { verificationId: v.id, provider: provider.key, error: s.error });
    return { ok: false, status: 502, error: "vendor_unavailable" };
  }
  await db.query(
    `UPDATE kyc_verifications SET vendor_applicant_id = $2, vendor_session_id = $3, session_url_enc = $4, session_expires_at = $5,
            status = 'in_progress', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id::text = $1`,
    [v.id, s.vendorApplicantId, s.vendorSessionId, await encryptJson(db as any, { url: s.url }), s.expiresAt ? s.expiresAt.toISOString() : null],
  );
  return { ok: true, mode: "hosted", url: s.url };
}

// ------------------------------------------------------------------------------------------------ results
const CATEGORY = "Identity verification";
const MEDIA_LABEL: Record<KycMedia["kind"], string> = { document_front: "ID-front", document_back: "ID-back", document: "ID", selfie: "Selfie" };

/** Stores ID images and selfies as accepted documents on the application. Returns the new document ids. */
export async function storeMediaAsDocuments(
  db: Db, v: { id: string; application_id: string }, items: Array<{ kind: KycMedia["kind"]; buffer: Buffer; contentType: string; filename: string }>,
  storage: Pick<StorageBackend, "put"> = getStorage(),
): Promise<string[]> {
  const ids: string[] = [];
  for (const m of items) {
    if (!m.buffer?.length) continue;
    const ext = (m.filename.split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
    const filename = `${MEDIA_LABEL[m.kind]}-verification-${v.id.slice(0, 8)}.${ext}`;
    const put = await storage.put({ buffer: m.buffer, filename, contentType: m.contentType || "image/jpeg", pathPrefix: `applications/${v.application_id}/identity` });
    const documentId = randomUUID();
    const hash = createHash("sha256").update(m.buffer).digest("hex");
    await db.query(
      `INSERT INTO documents (id, application_id, filename, hash, category, storage_path, blob_name, blob_url, size_bytes,
                              status, ocr_status, uploaded_by, document_type, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, 'accepted', 'skipped', 'system', $9, now(), now())`,
      [documentId, v.application_id, filename, hash, CATEGORY, put.blobName, put.url, put.sizeBytes, m.kind === "selfie" ? "id_verification_selfie" : "id_verification_document"],
    );
    await db.query(
      `INSERT INTO document_versions (id, document_id, version, blob_name, hash, metadata, content, created_at)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
      [randomUUID(), documentId, put.blobName, hash, JSON.stringify({ source: "id_verification", verification_id: v.id, kind: m.kind }), put.url],
    );
    ids.push(documentId);
  }
  return ids;
}

async function queueFraud(db: Db, applicationId: string): Promise<void> {
  try {
    await enqueueFraudRun(db, applicationId, "id_verification");
  } catch (err) {
    console.warn("[kyc] fraud re-run not queued", { applicationId, message: (err as Error)?.message });
  }
}

/** Ask the vendor for the current result and store it. Safe to run any number of times. */
export async function refreshFromVendor(v: KycRow, deps: KycDeps = {}): Promise<KycStatus | null> {
  const db = dbOf(deps);
  const provider = providersOf(deps)[v.provider as KycProviderKey];
  if (!provider?.fetchResult || !v.vendor_session_id) return null;
  if (v.decision_source === "staff") return v.status; // a staff decision is final
  const r = await provider.fetchResult(String(v.vendor_session_id), v.vendor_applicant_id ?? null);
  if (!r.ok) {
    console.warn("[kyc] vendor result not fetched", { verificationId: v.id, provider: provider.key, error: r.error });
    return null;
  }
  const res = r.result;
  const decided = res.status === "approved" || res.status === "declined" || res.status === "review";
  await db.query(
    `UPDATE kyc_verifications SET status = $2, reasons = $3::jsonb, checks = $4::jsonb, pii_enc = COALESCE($5, pii_enc),
            decision_source = CASE WHEN $6 THEN 'vendor' ELSE decision_source END,
            completed_at = CASE WHEN $6 OR $2 IN ('expired', 'error') THEN COALESCE(completed_at, now()) ELSE completed_at END,
            updated_at = now()
      WHERE id::text = $1`,
    [v.id, res.status, JSON.stringify(res.reasons), JSON.stringify(res.checks), res.pii ? await encryptJson(db as any, res.pii) : null, decided],
  );
  if (decided) {
    const have = Array.isArray(v.document_ids) ? v.document_ids : [];
    if (!have.length && res.media.length) {
      const files: Array<{ kind: KycMedia["kind"]; buffer: Buffer; contentType: string; filename: string }> = [];
      for (const m of res.media) {
        const f = await m.download();
        if (f) files.push({ kind: m.kind, ...f });
      }
      try {
        const ids = await storeMediaAsDocuments(db, { id: v.id, application_id: v.application_id }, files, deps.storage);
        if (ids.length) await db.query(`UPDATE kyc_verifications SET document_ids = $2::text[] WHERE id::text = $1`, [v.id, ids]);
      } catch (err) {
        console.warn("[kyc] ID images not stored", { verificationId: v.id, message: (err as Error)?.message });
      }
    }
  }
  if (res.status !== v.status) await queueFraud(db, v.application_id);
  return res.status;
}

export type WebhookOutcome = { status: number; outcome: "processed" | "duplicate" | "ignored" | "unknown_session" | "bad_signature" | "not_configured" };

export async function handleWebhook(providerKey: string, rawBody: Buffer | undefined, headers: Record<string, unknown>, body: unknown, deps: KycDeps = {}): Promise<WebhookOutcome> {
  const db = dbOf(deps);
  const provider = isProviderKey(providerKey) ? providersOf(deps)[providerKey] : undefined;
  if (!provider?.verifyWebhook || !provider.parseWebhook) return { status: 404, outcome: "ignored" };
  if (!provider.configured()) return { status: 503, outcome: "not_configured" };
  const raw = rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
  if (!provider.verifyWebhook(raw, headers)) return { status: 401, outcome: "bad_signature" };
  const ev = provider.parseWebhook(body, raw);
  if (!ev) return { status: 200, outcome: "ignored" };
  const first = await db.query(
    `INSERT INTO kyc_webhook_events (provider, event_key) VALUES ($1, $2) ON CONFLICT (provider, event_key) DO NOTHING RETURNING event_key`,
    [provider.key, ev.eventKey],
  );
  if (!first.rows.length) return { status: 200, outcome: "duplicate" };
  const mark = (outcome: string, vid: string | null) =>
    db.query(`UPDATE kyc_webhook_events SET outcome = $3, verification_id = $4::uuid WHERE provider = $1 AND event_key = $2`, [provider.key, ev.eventKey, outcome, vid]);
  if (!ev.vendorSessionId) { await mark("ignored", null); return { status: 200, outcome: "ignored" }; }
  const v = (await db.query(`SELECT ${COLUMNS} FROM kyc_verifications v WHERE v.provider = $1 AND v.vendor_session_id = $2 LIMIT 1`, [provider.key, ev.vendorSessionId])).rows[0];
  // A run this server did not start (a test account shared with another system): nothing to do here.
  if (!v) { await mark("unknown_session", null); return { status: 200, outcome: "unknown_session" }; }
  await refreshFromVendor(v, deps);
  await mark("processed", v.id);
  return { status: 200, outcome: "processed" };
}

// ------------------------------------------------------------------------------------------------ manual uploads (client)
export async function submitManualUpload(
  id: string, files: Array<{ kind: KycMedia["kind"]; buffer: Buffer; contentType: string; filename: string }>, deps: KycDeps = {},
): Promise<{ ok: true; status: KycStatus } | { ok: false; status: number; error: string }> {
  const db = dbOf(deps);
  const v = await getVerification(db, id);
  if (!v) return { ok: false, status: 404, error: "not_found" };
  if (v.provider !== "manual") return { ok: false, status: 409, error: "not_a_manual_verification" };
  if (!OPEN_STATUSES.has(v.status)) return { ok: false, status: 409, error: "already_submitted" };
  const kinds = new Set(files.map((f) => f.kind));
  if (!(kinds.has("document_front") || kinds.has("document")) || !kinds.has("selfie")) return { ok: false, status: 400, error: "id_and_selfie_required" };
  for (const f of files) {
    if (!/^image\/(jpeg|png|heic|heif|webp)$|^application\/pdf$/.test(f.contentType)) return { ok: false, status: 400, error: "unsupported_file_type" };
  }
  const ids = await storeMediaAsDocuments(db, { id: v.id, application_id: v.application_id }, files, deps.storage);
  await db.query(
    `UPDATE kyc_verifications SET status = 'review', document_ids = document_ids || $2::text[], started_at = COALESCE(started_at, now()),
            completed_at = now(), reasons = $3::jsonb, updated_at = now() WHERE id::text = $1`,
    [v.id, ids, JSON.stringify([{ code: "manual_submitted", severity: "amber", text: "The applicant uploaded their ID and a selfie. A staff member needs to compare them and decide." }])],
  );
  await queueFraud(db, v.application_id);
  return { ok: true, status: "review" };
}

// ------------------------------------------------------------------------------------------------ staff decisions
export async function staffDecision(
  id: string, decision: "approved" | "declined", note: string, userId: string | null, deps: KycDeps = {},
): Promise<{ ok: true; verification: KycRow } | { ok: false; status: number; error: string }> {
  const db = dbOf(deps);
  const v = await getVerification(db, id);
  if (!v) return { ok: false, status: 404, error: "not_found" };
  if (v.status !== "review" && !(v.provider === "manual" && OPEN_STATUSES.has(v.status))) return { ok: false, status: 409, error: "not_awaiting_review" };
  const clean = note.trim().slice(0, 500);
  const reasons = [...(arr(v.reasons) as KycReason[]).filter((r) => r.code !== "manual_submitted"), {
    code: `staff_${decision}`, severity: decision === "approved" ? "info" : "red",
    text: `A staff member ${decision === "approved" ? "approved" : "declined"} this verification${clean ? `: ${clean}` : "."}`,
  } satisfies KycReason];
  await db.query(
    `UPDATE kyc_verifications SET status = $2, decision_source = 'staff', reviewed_by = $3, reviewed_at = now(), review_note = $4,
            reasons = $5::jsonb, completed_at = COALESCE(completed_at, now()), updated_at = now() WHERE id::text = $1`,
    [v.id, decision, userId, clean || null, JSON.stringify(reasons)],
  );
  await queueFraud(db, v.application_id);
  return { ok: true, verification: (await getVerification(db, v.id))! };
}

export async function cancelVerification(id: string, userId: string | null, deps: KycDeps = {}): Promise<boolean> {
  const db = dbOf(deps);
  const r = await db.query(
    `UPDATE kyc_verifications SET status = 'cancelled', reviewed_by = $2, reviewed_at = now(), updated_at = now()
      WHERE id::text = $1 AND status IN ('requested', 'in_progress', 'processing') RETURNING application_id`,
    [id, userId],
  );
  if (r.rows[0]) await queueFraud(db, String(r.rows[0].application_id));
  return Boolean(r.rows[0]);
}

export { FINAL_STATUSES };
