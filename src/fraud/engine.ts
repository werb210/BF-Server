// BF_SERVER_v846_FRAUD - runs all 15 fraud checks for one application and stores the results.
// Called by the fraud worker (src/workers/fraudWorker.ts) from its queue. Idempotent: each check replaces its own
// row. A check that fails is stored as status "error" (and logged) without stopping the others.
import { createHash } from "node:crypto";
import type { Q } from "./types.js";
import { buildProfile, type AppProfile } from "./profile.js";
import { fraudProviders, type FraudProviders } from "./providers/index.js";
import { allowedChecks, listResults, previousResult, upsertResult } from "./store.js";
import { scanDocument, defaultLoadFile, type DocRow, type LoadFile } from "./documents.js";
import { hamming, NEAR_DUPLICATE_BITS } from "./imageHash.js";
import { evaluateDuplicates, type DuplicateHit } from "./checks/duplicates.js";
import { evaluateRevenue, type RevenueClaim } from "./checks/revenue.js";
import { addressSub, businessReality, contactRisk, domainAgeSub, emailMatchesName, lineTypeSub, registrySub } from "./checks/business.js";
import { classifyAddressByList } from "./providers/lookups.js";
import { registryNumber } from "./providers/registry.js";
import { emailDomain, normDomain, toE164, normName } from "./hash.js";
import { evaluateIdentity, type IdDoc } from "./checks/identity.js";
import { evaluateBehaviour, evaluateDevice, type DeviceRow } from "./checks/device.js";
import { detectStacking } from "./checks/stacking.js";
import { evaluateInsider, evaluateNetwork, evaluateVoice, type VoiceOutcome } from "./checks/misc.js";
import { buildNetwork, accountNumbersFor } from "./network.js";
import { checkWatchlist, evaluateWatchlist, watchlistEntries, watchlistReady } from "./watchlist.js";
import { getFraudSettings } from "./store.js";
import { computeScore } from "./score.js";
import { notApplicable, type CheckResult } from "./types.js";
import type { OpsFetch } from "./opsLink.js";

export type EngineDeps = {
  providers?: FraudProviders;
  loadFile?: LoadFile;
  opsFetch?: OpsFetch;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The countries Boreal lends in (two letters, comma separated) for the out-of-country rule. Default
   *  FRAUD_LENDING_COUNTRIES, else "CA,US". */
  licenseeCountry?: () => Promise<string | null>;
};

export async function loadProfile(db: Q, applicationId: string): Promise<AppProfile | null> {
  const a = await db.query(
    `SELECT id::text AS id, name, metadata, pipeline_state, fraud_confirmed_at, owner_user_id::text AS owner_user_id,
            company_id::text AS company_id, contact_id::text AS contact_id, business_legal_name, created_at
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const app = a.rows[0];
  if (!app) return null;
  const contact = app.contact_id
    ? (await db.query(`SELECT name, first_name, last_name, email, phone, dob, address_street, address_city, address_state, address_zip FROM contacts WHERE id::text = $1 LIMIT 1`, [app.contact_id])).rows[0] ?? null
    : null;
  const company = app.company_id
    ? (await db.query(`SELECT name, legal_name, website, domain, phone, address_street, address_city, address_state, address_zip, address_country, province, country, annual_revenue, estimated_annual_revenue FROM companies WHERE id::text = $1 LIMIT 1`, [app.company_id])).rows[0] ?? null
    : null;
  return buildProfile({ app, contact, company });
}

export function lendingCountries(env: NodeJS.ProcessEnv = process.env): string {
  const v = String(env.FRAUD_LENDING_COUNTRIES ?? "").toUpperCase().split(/[^A-Z]+/).filter((c) => c.length === 2);
  return v.length ? v.join(",") : "CA,US";
}

function inputHash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
}

/** Reuse a recent result when its inputs have not changed (saves paid lookups on every re-run). */
async function cached(db: Q, appId: string, key: string, hash: string, maxDays: number): Promise<boolean> {
  const prev = await previousResult(db, appId, key);
  if (!prev || prev.status === "error" || prev.details?.input_hash !== hash) return false;
  return Date.now() - new Date(prev.checked_at).getTime() < maxDays * 86_400_000;
}

async function businessKeyOf(db: Q, appIds: string[]): Promise<Map<string, { company: string | null; name: string | null; parent: string | null; fraud: boolean }>> {
  if (!appIds.length) return new Map();
  const r = await db.query(
    `SELECT id::text AS id, company_id::text AS company, lower(regexp_replace(COALESCE(business_legal_name, name, ''), '[^a-zA-Z0-9]', '', 'g')) AS name,
            parent_application_id AS parent, (pipeline_state = 'Fraud' OR fraud_confirmed_at IS NOT NULL) AS fraud
       FROM applications WHERE id::text = ANY($1::text[])`,
    [appIds],
  );
  return new Map(r.rows.map((x: any) => [x.id, { company: x.company ?? null, name: x.name || null, parent: x.parent ?? null, fraud: x.fraud === true }]));
}

function sameBusinessAs(p: AppProfile, me: { company: string | null; name: string | null; parent: string | null } | undefined, other: { company: string | null; name: string | null; parent: string | null } | undefined, otherId: string): boolean {
  if (!other) return false;
  if (other.parent === p.applicationId || (me?.parent && (me.parent === otherId || me.parent === other.parent))) return true;
  if (p.companyId && other.company && p.companyId === other.company) return true;
  const myName = (p.businessName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(myName && other.name && myName === other.name);
}

// ------------------------------------------------------------------------------------------------ check 4
export async function gatherDuplicates(db: Q, p: AppProfile): Promise<{ hits: DuplicateHit[]; documents: number }> {
  const mine = await db.query(`SELECT document_id, sha256, phashes, id_kind FROM document_fingerprints WHERE application_id = $1`, [p.applicationId]);
  const hits: DuplicateHit[] = [];
  const shas = mine.rows.map((r: any) => r.sha256).filter(Boolean);
  const raw: Array<{ app: string; match: "exact" | "near"; kind: DuplicateHit["idKind"]; distance?: number }> = [];
  if (shas.length) {
    const exact = await db.query(
      `SELECT f.application_id AS app, f.sha256 FROM document_fingerprints f WHERE f.sha256 = ANY($1::text[]) AND f.application_id <> $2
       UNION SELECT d.application_id AS app, d.hash AS sha256 FROM documents d WHERE d.hash = ANY($1::text[]) AND d.application_id <> $2`,
      [shas, p.applicationId],
    );
    for (const e of exact.rows) {
      const kind = mine.rows.find((m: any) => m.sha256 === e.sha256)?.id_kind ?? "other";
      raw.push({ app: String(e.app), match: "exact", kind });
    }
  }
  const myHashes = mine.rows.flatMap((r: any) => (Array.isArray(r.phashes) ? r.phashes : []).map((h: string) => ({ h, kind: r.id_kind })));
  if (myHashes.length) {
    const others = await db.query(
      `SELECT application_id AS app, phashes FROM document_fingerprints
        WHERE application_id <> $1 AND cardinality(phashes) > 0 AND created_at > now() - interval '3 years'
        ORDER BY created_at DESC LIMIT 20000`,
      [p.applicationId],
    );
    for (const o of others.rows) {
      for (const theirs of (o.phashes ?? []) as string[]) {
        const hit = myHashes.find((m: { h: string }) => hamming(m.h, theirs) <= NEAR_DUPLICATE_BITS);
        if (hit) { raw.push({ app: String(o.app), match: "near", kind: hit.kind, distance: hamming(hit.h, theirs) }); break; }
      }
    }
  }
  const ids = [...new Set(raw.map((r) => r.app))];
  const keys = await businessKeyOf(db, [...ids, p.applicationId]);
  const me = keys.get(p.applicationId);
  for (const r of raw) {
    const other = keys.get(r.app);
    if (!other) continue;
    hits.push({ match: r.match, idKind: r.kind, otherApplicationId: r.app, sameBusiness: sameBusinessAs(p, me, other, r.app), otherIsFraud: other.fraud, distance: r.distance });
  }
  return { hits, documents: mine.rows.length };
}

// ------------------------------------------------------------------------------------------------ check 5
export async function gatherRevenue(db: Q, p: AppProfile): Promise<{ claims: RevenueClaim[]; deposits: { monthlyAverage: number | null; months: number | null } }> {
  const claims: RevenueClaim[] = [];
  const fin = await db.query(
    `SELECT period, MAX(value)::float AS value FROM application_financials
      WHERE application_id = $1 AND kind = 'annual' AND line_item ~* '(total revenue|^revenue|sales|gross receipts|total income)'
      GROUP BY period ORDER BY period DESC LIMIT 1`,
    [p.applicationId],
  );
  if (fin.rows[0]?.value > 0) claims.push({ source: "financials", label: "Financial statements", min: fin.rows[0].value, max: fin.rows[0].value, period: fin.rows[0].period });
  const ocr = await db.query(
    `SELECT f.value, COALESCE(d.category, d.document_type, '') AS category FROM document_ocr_fields f
       JOIN documents d ON d.id = f.document_id
      WHERE f.application_id = $1 AND f.field_key IN ('total_revenue', 'gross_revenue', 'gross_sales', 'total_income')
      ORDER BY f.created_at DESC LIMIT 5`,
    [p.applicationId],
  );
  for (const o of ocr.rows) {
    const v = Number(String(o.value).replace(/[^0-9.-]/g, ""));
    if (!Number.isFinite(v) || v <= 1000) continue;
    const src = /tax|t2|t1|noa|cra/i.test(o.category) ? "tax_return" : "financials";
    if (claims.some((c) => c.source === src)) continue;
    claims.push({ source: src, label: src === "tax_return" ? "Tax return" : "Financial statements", min: v, max: v });
  }
  if (p.claimedAnnualRevenue) claims.push({ source: "application", label: "Application", ...p.claimedAnnualRevenue });
  const b = await db.query(`SELECT total_avg_monthly_deposits::float AS avg, months_detected AS months FROM banking_analyses WHERE application_id::text = $1 AND status = 'analysis_complete'`, [p.applicationId]);
  return { claims, deposits: { monthlyAverage: b.rows[0]?.avg ?? null, months: b.rows[0]?.months ?? null } };
}

// ------------------------------------------------------------------------------------------------ check 9 / 10
async function otherBusinessesSharing(db: Q, p: AppProfile, column: "device_hash" | "ip_hash" | "answers_hash", value: string | null): Promise<number> {
  if (!value) return 0;
  const r = await db.query(`SELECT application_id FROM fraud_device_signals WHERE ${column} = $1 AND application_id <> $2 LIMIT 50`, [value, p.applicationId]);
  const ids = r.rows.map((x: any) => String(x.application_id));
  const keys = await businessKeyOf(db, [...ids, p.applicationId]);
  const me = keys.get(p.applicationId);
  const distinct = new Set<string>();
  for (const id of ids) {
    const o = keys.get(id);
    if (o && !sameBusinessAs(p, me, o, id)) distinct.add(o.company ?? o.name ?? id);
  }
  return distinct.size;
}

// ------------------------------------------------------------------------------------------------ the run
export type RunSummary = { applicationId: string; ran: string[]; errors: string[] };

export async function runFraudChecks(db: Q, applicationId: string, deps: EngineDeps = {}): Promise<RunSummary | null> {
  const env = deps.env ?? process.env;
  const providers = deps.providers ?? fraudProviders(env);
  const p = await loadProfile(db, applicationId);
  if (!p) return null;
  const allowed = allowedChecks();
  const ran: string[] = [];
  const errors: string[] = [];
  const step = async (key: string, fn: () => Promise<CheckResult | null>) => {
    if (!allowed.has(key)) return;
    try {
      const r = await fn();
      if (r) await upsertResult(db, applicationId, key, "", r);
      ran.push(key);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      errors.push(`${key}: ${message}`);
      console.warn("[fraud] check failed", { applicationId, check: key, message });
      await upsertResult(db, applicationId, key, "", { status: "error", reasons: [{ code: "check_failed", severity: "info", text: "This check could not finish; it will run again with the next update." }] })
        .catch((e) => console.error("[fraud] could not store the failed check", { applicationId, check: key, message: (e as Error)?.message }));
    }
  };

  // Check 1 (and the fingerprints check 4 needs): every document not yet scanned.
  if (allowed.has("fraud_1") || allowed.has("fraud_4") || allowed.has("fraud_8")) {
    const docs = await db.query(
      `SELECT d.id::text AS id, d.application_id::text AS application_id, COALESCE(d.category, d.document_type, d.signed_category) AS category,
              d.storage_key, d.blob_name, d.storage_path
         FROM documents d LEFT JOIN document_fingerprints f ON f.document_id = d.id::text
        WHERE d.application_id::text = $1 AND f.document_id IS NULL AND COALESCE(d.uploaded_by, '') <> 'system'
        ORDER BY d.created_at ASC LIMIT 40`,
      [applicationId],
    );
    for (const d of docs.rows as DocRow[]) {
      try { await scanDocument(db, d, deps.loadFile ?? defaultLoadFile); }
      catch (err) {
        errors.push(`fraud_1:${d.id}: ${(err as Error)?.message ?? err}`);
        console.warn("[fraud] document scan failed", { applicationId, documentId: d.id, message: (err as Error)?.message });
        await upsertResult(db, applicationId, "fraud_1", d.id, { status: "error", reasons: [{ code: "scan_failed", severity: "info", text: "This file could not be scanned. Review it by eye." }] });
        await db.query(`INSERT INTO document_fingerprints (document_id, application_id, image_info) VALUES ($1, $2, '{"file_type":"error"}'::jsonb) ON CONFLICT (document_id) DO NOTHING`, [d.id, applicationId]);
      }
    }
    ran.push("fraud_1");
  }

  await step("fraud_4", async () => { const g = await gatherDuplicates(db, p); return g.documents ? evaluateDuplicates(g.hits, g.documents) : notApplicable("No documents have been scanned yet."); });
  await step("fraud_5", async () => { const g = await gatherRevenue(db, p); return evaluateRevenue(g.claims, g.deposits); });

  // Check 6: business reality (registry, address, website age, business phone).
  await step("fraud_6", async () => {
    const domain = normDomain(p.website);
    const hash = inputHash({ bn: p.businessNumber, a: p.businessAddress, d: domain, ph: p.businessPhone, n: p.applicant.name, o: p.owners.map((o) => o.name) });
    if (await cached(db, applicationId, "fraud_6", hash, 30)) return null;
    const num = registryNumber(p.businessNumber);
    const registry = !providers.registry.configured() ? registrySub("not_configured", [], null)
      : !num ? registrySub("no_number", [], null)
      : registrySub(await providers.registry.lookup(p.businessNumber!), [p.applicant.name, ...p.owners.map((o) => o.name)].filter((n): n is string => Boolean(n)), p.businessName);
    const addrType = p.businessAddress ? (await providers.address.classify(p.businessAddress)) ?? classifyAddressByList(p.businessAddress) : null;
    const website = domainAgeSub("website", domain, domain ? (providers.domainAge.configured() ? await providers.domainAge.age(domain) : "not_configured") : null);
    const phoneE164 = toE164(p.businessPhone);
    const phone = lineTypeSub("business phone", phoneE164, phoneE164 ? (providers.lineType.configured() ? await providers.lineType.lookup(phoneE164) : "not_configured") : null);
    const r = businessReality({ registry, address: addressSub(addrType, Boolean(p.businessAddress)), website, phone });
    return { ...r, details: { ...(r.details ?? {}), input_hash: hash } };
  });

  // Check 7: applicant phone and email risk.
  await step("fraud_7", async () => {
    const domain = emailDomain(p.applicant.email);
    const phoneE164 = toE164(p.applicant.phone);
    const hash = inputHash({ e: p.applicant.email, p: phoneE164, n: p.applicant.name, b: p.businessName });
    if (await cached(db, applicationId, "fraud_7", hash, 30)) return null;
    const phone = lineTypeSub("applicant's phone", phoneE164, phoneE164 ? (providers.lineType.configured() ? await providers.lineType.lookup(phoneE164) : "not_configured") : null);
    const emailAge = domainAgeSub("email domain", domain, domain ? (providers.domainAge.configured() ? await providers.domainAge.age(domain) : "not_configured") : null);
    const r = contactRisk({ email: p.applicant.email, domain, emailDomainAge: emailAge, phone, nameMatch: emailMatchesName(p.applicant.email, p.applicant.firstName ?? p.applicant.name?.split(" ")[0] ?? null, p.applicant.lastName ?? p.applicant.name?.split(" ").slice(-1)[0] ?? null, p.businessName) });
    return { ...r, details: { ...(r.details ?? {}), input_hash: hash } };
  });

  // Check 8: ID documents.
  await step("fraud_8", async () => {
    const ids = await db.query(
      `SELECT f.document_id, f.image_info, f.phashes, f.sha256 FROM document_fingerprints f WHERE f.application_id = $1 AND f.id_kind = 'id'`,
      [applicationId],
    );
    const fields = ids.rows.length ? await db.query(
      `SELECT document_id, field_key, value FROM document_ocr_fields
        WHERE document_id = ANY($1::text[]) AND field_key IN ('full_name', 'name', 'first_name', 'last_name', 'date_of_birth', 'dob', 'birth_date')`,
      [ids.rows.map((r: any) => r.document_id)],
    ) : { rows: [] as any[] };
    const docs: IdDoc[] = ids.rows.map((r: any) => {
      const fs = fields.rows.filter((f: any) => f.document_id === r.document_id);
      const get = (...k: string[]) => fs.find((f: any) => k.includes(f.field_key))?.value ?? null;
      const name = get("full_name", "name") ?? ([get("first_name"), get("last_name")].filter(Boolean).join(" ") || null);
      const info = r.image_info ?? {};
      return { documentId: r.document_id, ocrName: name, ocrDob: get("date_of_birth", "dob", "birth_date"), fileType: info.file_type ?? "other", width: info.width ?? null, height: info.height ?? null, screenSized: info.screen_sized === true, hasCameraExif: info.camera === true, editorSoftware: info.editor ?? null };
    });
    const dup = docs.length ? await gatherDuplicates(db, p) : { hits: [] as DuplicateHit[] };
    const reused = new Set(dup.hits.filter((h) => h.idKind === "id" && !h.sameBusiness).map((h) => h.otherApplicationId)).size;
    return evaluateIdentity({ idDocs: docs, applicantName: p.applicant.name, applicantDob: p.applicant.dob, ownerNames: p.owners.map((o) => o.name).filter((n): n is string => Boolean(n)), reusedElsewhere: reused, idvConfigured: providers.idv.configured() });
  });

  // Checks 9 and 10: device, location and behaviour signals from the client app.
  const deviceRow = (allowed.has("fraud_9") || allowed.has("fraud_10"))
    ? ((await db.query(`SELECT device_hash, ip_hash, ip_country, ip_region, asn, asn_org, ip_flags, ip_provider, behaviour, answers_hash FROM fraud_device_signals WHERE application_id = $1`, [applicationId])).rows[0] as DeviceRow | undefined) ?? null
    : null;
  await step("fraud_9", async () => evaluateDevice({
    row: deviceRow,
    otherBusinessesSameDevice: await otherBusinessesSharing(db, p, "device_hash", deviceRow?.device_hash ?? null),
    otherBusinessesSameIp: await otherBusinessesSharing(db, p, "ip_hash", deviceRow?.ip_hash ?? null),
    licenseeCountry: deps.licenseeCountry ? await deps.licenseeCountry() : lendingCountries(env),
    businessProvince: p.businessProvince,
    ipConfigured: providers.ipIntel.configured() || Boolean(deviceRow?.ip_provider),
  }));
  await step("fraud_10", async () => evaluateBehaviour({ row: deviceRow, sameAnswersOtherBusinesses: await otherBusinessesSharing(db, p, "answers_hash", deviceRow?.answers_hash ?? null) }));

  await step("fraud_11", async () => {
    const t = await db.query(`SELECT transaction_date::text AS date, description, amount::float AS amount FROM banking_transactions WHERE application_id::text = $1 ORDER BY transaction_date`, [applicationId]);
    return detectStacking(t.rows, p.disclosedDebtText);
  });

  await step("fraud_12", async () => evaluateNetwork(await buildNetwork(db, p), applicationId));

  await step("fraud_13", async () => {
    const settings = await getFraudSettings(db);
    const ready = watchlistReady(env);
    const entries = settings.watchlist_opt_in && ready.ok ? watchlistEntries(p, { bankAccounts: await accountNumbersFor(db, applicationId) }, env) : [];
    const check = entries.length ? await checkWatchlist(entries, { env, fetchImpl: deps.opsFetch }) : null;
    if (check && !check.ok) console.warn("[fraud] watchlist check failed", { applicationId, error: check.error });
    return evaluateWatchlist({ optIn: settings.watchlist_opt_in, ready, check, entries: entries.length });
  });

  await step("fraud_14", async () => {
    const ev = await db.query(
      `SELECT e.kind, e.severity, e.created_at, COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS user_label
         FROM staff_risk_events e LEFT JOIN users u ON u.id::text = e.user_id
        WHERE e.application_id = $1 AND e.severity IN ('amber', 'red') ORDER BY e.created_at DESC LIMIT 20`,
      [applicationId],
    );
    return evaluateInsider(ev.rows.map((r: any) => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
  });

  await step("fraud_15", async () => {
    const recs = await db.query(
      `SELECT DISTINCT recording_sid FROM call_logs
        WHERE recording_sid IS NOT NULL AND (application_id = $1 OR ($2::text IS NOT NULL AND (contact_id::text = $2 OR crm_contact_id::text = $2)))
        LIMIT 10`,
      [applicationId, p.contactId],
    );
    const outcomes: VoiceOutcome[] = [];
    const sid = String(env.TWILIO_ACCOUNT_SID ?? "");
    for (const r of recs.rows) {
      if (!providers.voice.configured()) { outcomes.push({ recordingId: r.recording_sid, status: "not_configured" }); continue; }
      const v = await providers.voice.analyze({ recordingId: r.recording_sid, url: `https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${r.recording_sid}.mp3` });
      outcomes.push(v.ok ? { recordingId: r.recording_sid, status: v.verdict, probability: v.synthetic_probability } : { recordingId: r.recording_sid, status: "error" });
    }
    return evaluateVoice(outcomes, providers.voice.configured());
  });

  // Check 16 last: the score over everything stored.
  await step("fraud_16", async () => {
    const all = await listResults(db, applicationId);
    const s = computeScore(all, allowed);
    return {
      status: s.band === "high" ? "red" : s.band === "medium" ? "amber" : "green",
      reasons: s.reasons.length ? s.reasons.map((r) => ({ code: r.check, severity: r.severity, text: r.text })) : [{ code: "score_clean", severity: "info", text: "No fraud signals were found by the checks that ran." }],
      details: { score: s.score, band: s.band, covered: s.covered.length, not_covered: s.not_covered.length },
    };
  });

  return { applicationId, ran, errors };
}

/** Exported for the route's network view. */
export { buildNetwork };
export function profileName(p: AppProfile): string | null { return p.businessName ?? (normName(p.applicant.name) ? p.applicant.name : null); }
