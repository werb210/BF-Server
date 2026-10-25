// BF_SERVER_v855_RETENTION - the rules for keeping records (Todd, Oct 24). Pure: nothing here touches the database.
//
// What is kept: applications, uploaded documents, signed agreements (stored as documents), generated lender
// packages and audit events.
// How long: 7 years from the later of the upload and the file's closing.
// When a file closes (the same test as ks_application_is_closed in migrations/2026_10_24_v855_retention.sql):
//   funded    funded_at is set, or pipeline_state is Accepted / Funded
//   declined  pipeline_state is Rejected / Declined
//   withdrawn pipeline_state is Withdrawn / Closed / Archived, or application_status is withdrawn / declined /
//             expired / completed
// Parked stages (Fraud, Hold) and every working stage are open: their records stay locked until the file closes.
// A draft that was never submitted or signed and has nothing on file (no documents, no packages) is not a record.
// Legal holds: while an admin's hold covers an application, contact or company, nothing under it can be deleted or
// purged, whatever the date.
// After 7 years a record becomes eligible: it is listed in the admin Retention report. Nothing is deleted
// automatically.

export const RETENTION_YEARS = 7;

const CLOSED_PIPELINE_STATES = new Set(["accepted", "funded", "rejected", "declined", "withdrawn", "closed", "archived"]);
const CLOSED_APPLICATION_STATUSES = new Set(["withdrawn", "declined", "expired", "completed"]);

export function isClosedFile(a: { pipeline_state?: string | null; application_status?: string | null; funded_at?: unknown }): boolean {
  if (a.funded_at) return true;
  if (CLOSED_PIPELINE_STATES.has(String(a.pipeline_state ?? "").trim().toLowerCase())) return true;
  return CLOSED_APPLICATION_STATUSES.has(String(a.application_status ?? "").trim().toLowerCase());
}

export function addYears(d: Date, years: number = RETENTION_YEARS): Date {
  const out = new Date(d.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + years);
  // Match Postgres interval arithmetic: February 29 becomes February 28 in a non-leap year.
  if (out.getUTCMonth() !== d.getUTCMonth()) out.setUTCDate(0);
  return out;
}

export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The date a record can be deleted: 7 years after the later of upload and closing; null while the file is open. */
export function retainUntil(uploadedAt: Date | null, closedAt: Date | null): Date | null {
  if (!closedAt) return null;
  const anchor = uploadedAt && uploadedAt.getTime() > closedAt.getTime() ? uploadedAt : closedAt;
  return addYears(anchor);
}

/** "2033-10-24" */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type HoldSummary = { id: string; target_type: string; target_id: string; target_label: string | null; reason: string; placed_at: string | null };

export type RetentionStatus = {
  /** true = may not be deleted now. */
  locked: boolean;
  /** "hold" beats "retention"; null when deletable. */
  reason: "hold" | "retention" | null;
  /** The first day it can be deleted (null while the file is open, or when it is not a record). */
  deletable_on: string | null;
  /** While the file is open: the earliest it could ever be deleted (7 years after upload). */
  earliest_deletable_on: string | null;
  file_open: boolean;
  holds: HoldSummary[];
  message: string | null;
};

export type RetentionFacts = {
  /** false: not a record (an empty draft) - deletable unless held. */
  is_record: boolean;
  uploaded_at: Date | null;
  closed_at: Date | null;
  holds: HoldSummary[];
  /** What is being deleted, for the message ("This document", "This application"). */
  noun: string;
};

/** Whether something may be deleted now, and the message staff see when it may not. */
export function retentionStatus(f: RetentionFacts, now: Date = new Date()): RetentionStatus {
  const until = f.is_record ? retainUntil(f.uploaded_at, f.closed_at) : null;
  const fileOpen = f.is_record && !f.closed_at;
  const earliest = fileOpen && f.uploaded_at ? isoDay(addYears(f.uploaded_at)) : null;
  const base = { deletable_on: until ? isoDay(until) : null, earliest_deletable_on: earliest, file_open: fileOpen, holds: f.holds };
  if (f.holds.length) {
    const why = f.holds.map((h) => h.reason).filter(Boolean).join("; ");
    return {
      ...base, locked: true, reason: "hold",
      message: `${f.noun} is under a legal hold${why ? ` (${why})` : ""} and cannot be deleted until an admin releases the hold.`,
    };
  }
  if (!f.is_record) return { ...base, locked: false, reason: null, message: null };
  if (fileOpen) {
    return {
      ...base, locked: true, reason: "retention",
      message: `${f.noun} is kept for ${RETENTION_YEARS} years after the file closes. The file is still open, so it cannot be deleted` +
        (earliest ? ` (the earliest it could be deleted is ${earliest})` : "") + ".",
    };
  }
  if (until && until.getTime() > now.getTime()) {
    return {
      ...base, locked: true, reason: "retention",
      message: `${f.noun} is kept for ${RETENTION_YEARS} years and cannot be deleted before ${isoDay(until)}.`,
    };
  }
  return { ...base, locked: false, reason: null, message: null };
}

/** The 423 body a refused delete returns. */
export function lockedBody(s: RetentionStatus) {
  return {
    ok: false,
    error: s.reason === "hold" ? "legal_hold" : "retention_locked",
    code: s.reason === "hold" ? "legal_hold" : "retention_locked",
    message: s.message,
    deletable_on: s.deletable_on,
    earliest_deletable_on: s.earliest_deletable_on,
    file_open: s.file_open,
    holds: s.holds,
  };
}

export const HOLD_TARGETS = ["application", "contact", "company"] as const;
export type HoldTarget = (typeof HOLD_TARGETS)[number];
export function isHoldTarget(v: unknown): v is HoldTarget {
  return typeof v === "string" && (HOLD_TARGETS as readonly string[]).includes(v);
}
