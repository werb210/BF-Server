// BF_SERVER_v855_RETENTION - retention checks, legal holds and the eligible-for-deletion report, read from the
// retention_applications / retention_documents views (migrations/2026_10_24_v855_retention.sql). The rules are in
// policy.ts.
import { pool } from "../db.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
/** Anything with pg's query(): the pool, a client, or a test fake. */
export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
import {
  isoDay, lockedBody, retentionStatus, toDate, type HoldSummary, type HoldTarget, type RetentionStatus,
} from "./policy.js";

const defaultDb = (): Q => pool as unknown as Q;

const HOLD_COLUMNS = `h.id::text AS id, h.target_type, h.target_id, h.target_label, h.reason, h.placed_at`;

function holdOf(r: any): HoldSummary {
  return {
    id: String(r.id),
    target_type: String(r.target_type),
    target_id: String(r.target_id),
    target_label: r.target_label ?? null,
    reason: String(r.reason ?? ""),
    placed_at: toDate(r.placed_at)?.toISOString() ?? null,
  };
}

/** Active holds that cover an application: on it, on a contact linked to it, or on its company. */
export async function holdsForApplication(applicationId: string, db: Q = defaultDb()): Promise<HoldSummary[]> {
  const r = await db.query(
    `SELECT ${HOLD_COLUMNS}
       FROM legal_holds h
      WHERE h.released_at IS NULL
        AND ((h.target_type = 'application' AND h.target_id = $1)
          OR (h.target_type = 'contact' AND h.target_id IN (
                SELECT contact_id::text FROM applications WHERE id::text = $1 AND contact_id IS NOT NULL
                UNION SELECT contact_id::text FROM application_contacts WHERE application_id::text = $1))
          OR (h.target_type = 'company' AND h.target_id IN (
                SELECT company_id::text FROM applications WHERE id::text = $1 AND company_id IS NOT NULL
                UNION SELECT c.company_id::text FROM applications a JOIN contacts c ON c.id = a.contact_id
                       WHERE a.id::text = $1 AND c.company_id IS NOT NULL)))
      ORDER BY h.placed_at`,
    [applicationId],
  );
  return r.rows.map(holdOf);
}

/** Active holds on a contact, or on the contact's company. */
export async function holdsForContact(contactId: string, db: Q = defaultDb()): Promise<HoldSummary[]> {
  const r = await db.query(
    `SELECT ${HOLD_COLUMNS}
       FROM legal_holds h
      WHERE h.released_at IS NULL
        AND ((h.target_type = 'contact' AND h.target_id = $1)
          OR (h.target_type = 'company' AND h.target_id IN (SELECT company_id::text FROM contacts WHERE id::text = $1 AND company_id IS NOT NULL)))
      ORDER BY h.placed_at`,
    [contactId],
  );
  return r.rows.map(holdOf);
}

export async function holdsForCompany(companyId: string, db: Q = defaultDb()): Promise<HoldSummary[]> {
  const r = await db.query(
    `SELECT ${HOLD_COLUMNS} FROM legal_holds h WHERE h.released_at IS NULL AND h.target_type = 'company' AND h.target_id = $1 ORDER BY h.placed_at`,
    [companyId],
  );
  return r.rows.map(holdOf);
}

/** null when the application does not exist. */
export async function applicationRetention(applicationId: string, db: Q = defaultDb(), now: Date = new Date()): Promise<RetentionStatus | null> {
  const r = await db.query(
    `SELECT application_id, is_record, created_at, last_upload_at, closed_at FROM retention_applications WHERE application_id = $1`,
    [applicationId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const created = toDate(row.created_at);
  const last = toDate(row.last_upload_at);
  const uploaded = created && last ? (last > created ? last : created) : (last ?? created);
  return retentionStatus({
    is_record: row.is_record === true,
    uploaded_at: uploaded,
    closed_at: toDate(row.closed_at),
    holds: await holdsForApplication(applicationId, db),
    noun: "This application",
  }, now);
}

/** null when the document does not exist. */
export async function documentRetention(documentId: string, db: Q = defaultDb(), now: Date = new Date()): Promise<RetentionStatus | null> {
  const r = await db.query(
    `SELECT document_id, application_id, uploaded_at, closed_at FROM retention_documents WHERE document_id = $1`,
    [documentId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return retentionStatus({
    is_record: true,
    uploaded_at: toDate(row.uploaded_at),
    closed_at: toDate(row.closed_at),
    holds: await holdsForApplication(String(row.application_id), db),
    noun: "This document",
  }, now);
}

/** Every document on an application, keyed by id (for the portal's delete buttons). */
export async function documentRetentionForApplication(applicationId: string, db: Q = defaultDb(), now: Date = new Date()): Promise<Record<string, RetentionStatus>> {
  const r = await db.query(
    `SELECT document_id, uploaded_at, closed_at FROM retention_documents WHERE application_id = $1`,
    [applicationId],
  );
  if (!r.rows.length) return {};
  const holds = await holdsForApplication(applicationId, db);
  const out: Record<string, RetentionStatus> = {};
  for (const row of r.rows) {
    out[String(row.document_id)] = retentionStatus(
      { is_record: true, uploaded_at: toDate(row.uploaded_at), closed_at: toDate(row.closed_at), holds, noun: "This document" },
      now,
    );
  }
  return out;
}

/** Folds the statuses of the files linked to a contact or company into one. */
function linkedStatus(noun: string, holds: HoldSummary[], linked: RetentionStatus[]): RetentionStatus {
  if (holds.length) return retentionStatus({ is_record: false, uploaded_at: null, closed_at: null, holds, noun }, new Date());
  const locked = linked.filter((s) => s.locked);
  if (!locked.length) return { locked: false, reason: null, deletable_on: null, earliest_deletable_on: null, file_open: false, holds: [], message: null };
  const viaHold = locked.filter((s) => s.reason === "hold");
  if (viaHold.length) {
    return { ...viaHold[0], message: `${noun} is linked to a file under a legal hold and cannot be deleted until the hold is released.` };
  }
  const open = locked.some((s) => s.file_open);
  const dates = locked.map((s) => s.deletable_on).filter((d): d is string => Boolean(d)).sort();
  const last = dates[dates.length - 1] ?? null;
  const files = `${locked.length} file${locked.length === 1 ? "" : "s"}`;
  return {
    locked: true,
    reason: "retention",
    deletable_on: open ? null : last,
    earliest_deletable_on: null,
    file_open: open,
    holds: [],
    message: open
      ? `${noun} is linked to ${files} still kept on record (at least one is still open), so it cannot be deleted.`
      : `${noun} is linked to ${files} kept on record and cannot be deleted before ${last}.`,
  };
}

async function linkedApplicationStatuses(whereSql: string, id: string, db: Q, now: Date): Promise<RetentionStatus[]> {
  const r = await db.query(
    `SELECT ra.application_id FROM retention_applications ra JOIN applications a ON a.id::text = ra.application_id
      WHERE ra.is_record AND (${whereSql})`,
    [id],
  );
  const out: RetentionStatus[] = [];
  for (const row of r.rows) {
    const s = await applicationRetention(String(row.application_id), db, now);
    if (s) out.push(s);
  }
  return out;
}

export async function contactRetention(contactId: string, db: Q = defaultDb(), now: Date = new Date()): Promise<RetentionStatus> {
  const holds = await holdsForContact(contactId, db);
  const linked = holds.length ? [] : await linkedApplicationStatuses(
    `a.contact_id::text = $1 OR EXISTS (SELECT 1 FROM application_contacts ac WHERE ac.application_id::text = a.id::text AND ac.contact_id::text = $1)`,
    contactId, db, now,
  );
  return linkedStatus("This contact", holds, linked);
}

export async function companyRetention(companyId: string, db: Q = defaultDb(), now: Date = new Date()): Promise<RetentionStatus> {
  const holds = await holdsForCompany(companyId, db);
  const linked = holds.length ? [] : await linkedApplicationStatuses(
    `a.company_id::text = $1 OR EXISTS (SELECT 1 FROM contacts c WHERE c.id = a.contact_id AND c.company_id::text = $1)`,
    companyId, db, now,
  );
  return linkedStatus("This company", holds, linked);
}

export type RetentionTarget = "application" | "document" | "contact" | "company";

export async function retentionFor(type: RetentionTarget, id: string, db: Q = defaultDb(), now: Date = new Date()): Promise<RetentionStatus | null> {
  if (type === "application") return applicationRetention(id, db, now);
  if (type === "document") return documentRetention(id, db, now);
  if (type === "contact") return contactRetention(id, db, now);
  return companyRetention(id, db, now);
}

/**
 * For delete routes: when the item is locked, answers 423 with the message and the date, records the refused attempt
 * in the audit log, and returns true (the caller stops). Returns false when the delete may go ahead.
 */
export async function refuseIfLocked(
  req: any, res: any, type: RetentionTarget, id: string, db: Q = defaultDb(),
): Promise<boolean> {
  const s = await retentionFor(type, id, db);
  if (!s || !s.locked) return false;
  await auditRefusal(req, type, id, s);
  res.status(423).json(lockedBody(s));
  return true;
}

async function auditRefusal(req: any, type: RetentionTarget, id: string, s: RetentionStatus): Promise<void> {
  try {
    await recordAuditEvent({
      actorUserId: actorId(req), targetUserId: null, targetType: type, targetId: id,
      action: "retention.delete_refused", success: false,
      metadata: { reason: s.reason, deletable_on: s.deletable_on, holds: s.holds.map((h) => h.id) },
    });
  } catch (err) {
    console.warn("[retention] could not audit a refused delete", { type, id, error: (err as Error)?.message ?? String(err) });
  }
}

/** Of these ids, the ones that may not be deleted now, with why (bulk deletes refuse the whole batch). */
export async function lockedAmong(type: "contact" | "company", ids: string[], db: Q = defaultDb()): Promise<Array<{ id: string } & RetentionStatus>> {
  const out: Array<{ id: string } & RetentionStatus> = [];
  for (const id of ids) {
    const s = await retentionFor(type, id, db);
    if (s?.locked) out.push({ id, ...s });
  }
  return out;
}

/** Refuse the entire batch, auditing every locked target and using the same 423 contract as single deletes. */
export async function refuseIfAnyLocked(req: any, res: any, type: "contact" | "company", ids: string[], db: Q = defaultDb()): Promise<boolean> {
  const locked = await lockedAmong(type, ids, db);
  if (!locked.length) return false;
  for (const s of locked) await auditRefusal(req, type, s.id, s);
  const primary = locked.find((s) => s.reason === "hold") ?? locked[0];
  res.status(423).json({ ...lockedBody(primary), locked, protectedIds: locked.map((s) => s.id) });
  return true;
}

function actorId(req: any): string | null {
  const v = String(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? "");
  return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

function actorName(req: any): string | null {
  const v = String(req?.user?.name ?? req?.user?.email ?? req?.user?.phone ?? "").trim();
  return v || null;
}

// ---------------------------------------------------------------- legal holds

export type HoldRow = HoldSummary & {
  placed_by_name: string | null;
  released_at: string | null;
  released_by_name: string | null;
  release_reason: string | null;
};

function holdRow(r: any): HoldRow {
  return {
    ...holdOf(r),
    placed_by_name: r.placed_by_name ?? null,
    released_at: toDate(r.released_at)?.toISOString() ?? null,
    released_by_name: r.released_by_name ?? null,
    release_reason: r.release_reason ?? null,
  };
}

/** The holds placed in a silo (a hold itself applies wherever the record is used). */
export async function listHolds(opts: { includeReleased?: boolean; silo?: string } = {}, db: Q = defaultDb()): Promise<HoldRow[]> {
  const r = await db.query(
    `SELECT h.id::text AS id, h.target_type, h.target_id, h.target_label, h.reason, h.placed_at, h.placed_by_name,
            h.released_at, h.released_by_name, h.release_reason
       FROM legal_holds h
      WHERE h.silo = $1 ${opts.includeReleased ? "" : "AND h.released_at IS NULL"}
      ORDER BY h.released_at IS NULL DESC, h.placed_at DESC
      LIMIT 500`,
    [opts.silo ?? "BF"],
  );
  return r.rows.map(holdRow);
}

/** The display name of a hold target, or null when it does not exist. */
async function targetLabel(type: HoldTarget, id: string, db: Q): Promise<string | null> {
  if (type === "application") {
    const r = await db.query(`SELECT label FROM retention_applications WHERE application_id = $1`, [id]);
    return r.rows[0] ? String(r.rows[0].label ?? id) : null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  if (type === "contact") {
    const r = await db.query(
      `SELECT COALESCE(NULLIF(name, ''), NULLIF(trim(concat_ws(' ', first_name, last_name)), ''), email, phone, id::text) AS label FROM contacts WHERE id = $1::uuid`,
      [id],
    );
    return r.rows[0] ? String(r.rows[0].label) : null;
  }
  const r = await db.query(`SELECT COALESCE(NULLIF(name, ''), NULLIF(legal_name, ''), id::text) AS label FROM companies WHERE id = $1::uuid`, [id]);
  return r.rows[0] ? String(r.rows[0].label) : null;
}

export type PlaceHoldResult =
  | { ok: true; hold: HoldRow }
  | { ok: false; status: number; error: string; message: string };

export async function placeHold(req: any, type: HoldTarget, id: string, reason: string, db: Q = defaultDb(), silo: string = "BF"): Promise<PlaceHoldResult> {
  const label = await targetLabel(type, id, db);
  if (label === null) return { ok: false, status: 404, error: "not_found", message: `That ${type} does not exist.` };
  const r = await db.query(
    `INSERT INTO legal_holds (target_type, target_id, target_label, reason, placed_by, placed_by_name, silo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (target_type, target_id) WHERE released_at IS NULL DO NOTHING
     RETURNING id::text AS id, target_type, target_id, target_label, reason, placed_at, placed_by_name,
               released_at, released_by_name, release_reason`,
    [type, id, label, reason, actorId(req), actorName(req), silo],
  );
  if (!r.rows[0]) return { ok: false, status: 409, error: "already_held", message: `This ${type} is already under a legal hold.` };
  const hold = holdRow(r.rows[0]);
  await recordAuditEvent({
    actorUserId: actorId(req), targetUserId: null, targetType: type, targetId: id,
    action: "legal_hold.placed", success: true, metadata: { hold_id: hold.id, reason, label, silo },
  });
  return { ok: true, hold };
}

export async function releaseHold(req: any, holdId: string, releaseReason: string, db: Q = defaultDb()): Promise<PlaceHoldResult> {
  const r = await db.query(
    `UPDATE legal_holds
        SET released_at = now(), released_by = $2, released_by_name = $3, release_reason = $4
      WHERE id::text = $1 AND released_at IS NULL
      RETURNING id::text AS id, target_type, target_id, target_label, reason, placed_at, placed_by_name,
                released_at, released_by_name, release_reason`,
    [holdId, actorId(req), actorName(req), releaseReason || null],
  );
  if (!r.rows[0]) return { ok: false, status: 404, error: "not_found", message: "That hold does not exist or was already released." };
  const hold = holdRow(r.rows[0]);
  await recordAuditEvent({
    actorUserId: actorId(req), targetUserId: null, targetType: hold.target_type, targetId: hold.target_id,
    action: "legal_hold.released", success: true, metadata: { hold_id: hold.id, reason: hold.reason, release_reason: releaseReason || null },
  });
  return { ok: true, hold };
}

// ---------------------------------------------------------------- the Retention report

export type RetentionReport = {
  generated_at: string;
  retention_years: number;
  eligible_applications: Array<{ application_id: string; label: string; silo: string | null; closed_at: string | null; eligible_since: string }>;
  eligible_documents: Array<{ document_id: string; application_id: string; label: string | null; application_label: string | null; eligible_since: string }>;
  eligible_audit_events: { count: number; oldest: string | null };
  totals: { records: number; open_files: number; locked_until_date: number; held: number; eligible: number };
};

/**
 * What can be deleted now: records past their 7 years and not under a hold. Nothing is deleted here; an admin
 * decides. Documents are listed on their own when their application as a whole is not yet eligible. Applications and
 * documents are those of the silo asked for; audit events are counted across the whole server.
 */
export async function retentionReport(db: Q = defaultDb(), now: Date = new Date(), limit = 500, silo: string = "BF"): Promise<RetentionReport> {
  const at = now.toISOString();
  const apps = await db.query(
    `SELECT application_id, label, silo, closed_at, retain_until
       FROM retention_applications
      WHERE is_record AND NOT held AND retain_until IS NOT NULL AND retain_until <= $1::timestamptz
        AND COALESCE(silo, 'BF') = $2
      ORDER BY retain_until
      LIMIT ${Math.max(1, Math.min(5000, Math.floor(limit)))}`,
    [at, silo],
  );
  const docs = await db.query(
    `SELECT d.document_id, d.application_id, d.label, d.application_label, d.retain_until
       FROM retention_documents d
       JOIN retention_applications ra ON ra.application_id = d.application_id
      WHERE NOT d.held AND d.retain_until IS NOT NULL AND d.retain_until <= $1::timestamptz
        AND NOT (ra.retain_until IS NOT NULL AND ra.retain_until <= $1::timestamptz)
        AND COALESCE(d.silo, 'BF') = $2
      ORDER BY d.retain_until
      LIMIT ${Math.max(1, Math.min(5000, Math.floor(limit)))}`,
    [at, silo],
  );
  const audit = await db.query(
    `SELECT count(*)::int AS count, min(created_at) AS oldest FROM audit_events WHERE created_at <= $1::timestamptz - interval '7 years'`,
    [at],
  );
  const totals = await db.query(
    `SELECT count(*) FILTER (WHERE is_record)::int AS records,
            count(*) FILTER (WHERE is_record AND closed_at IS NULL)::int AS open_files,
            count(*) FILTER (WHERE is_record AND NOT held AND retain_until > $1::timestamptz)::int AS locked_until_date,
            count(*) FILTER (WHERE is_record AND held)::int AS held,
            count(*) FILTER (WHERE is_record AND NOT held AND retain_until <= $1::timestamptz)::int AS eligible
       FROM retention_applications
      WHERE COALESCE(silo, 'BF') = $2`,
    [at, silo],
  );
  const day = (v: unknown) => { const d = toDate(v); return d ? isoDay(d) : ""; };
  const t = totals.rows[0] ?? {};
  return {
    generated_at: at,
    retention_years: 7,
    eligible_applications: apps.rows.map((r: any) => ({
      application_id: String(r.application_id), label: String(r.label ?? r.application_id), silo: r.silo ?? null,
      closed_at: toDate(r.closed_at)?.toISOString() ?? null, eligible_since: day(r.retain_until),
    })),
    eligible_documents: docs.rows.map((r: any) => ({
      document_id: String(r.document_id), application_id: String(r.application_id), label: r.label ?? null,
      application_label: r.application_label ?? null, eligible_since: day(r.retain_until),
    })),
    eligible_audit_events: { count: Number(audit.rows[0]?.count ?? 0), oldest: toDate(audit.rows[0]?.oldest)?.toISOString() ?? null },
    totals: {
      records: Number(t.records ?? 0), open_files: Number(t.open_files ?? 0), locked_until_date: Number(t.locked_until_date ?? 0),
      held: Number(t.held ?? 0), eligible: Number(t.eligible ?? 0),
    },
  };
}
