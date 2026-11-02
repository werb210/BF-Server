// BF_SERVER_v873_LENDER_API - what happens when a lender tells us something about a deal (from a poll, a webhook or the
// submission answer): the status timeline, the lender's offers in the Offers list, conditions and document requests,
// funding, the application's pipeline stage, a notification to the assigned staff member and an audit entry.
// Boreal additions: a lender's conditions and document requests are copied into the file's funding conditions
// checklist (v865), and a balance the lender reports on a funded deal is recorded on the file's Active Contract (v866).
import { randomUUID } from "node:crypto";
import type { Q } from "../settingsPack/common.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { ALBERTA_TZ } from "../lib/albertaTime.js";
import { localDateIn } from "../lib/permanentTime.js";
import { BUCKET_LABELS, FUNDED_POLL_MINUTES, stopsPolling, type LenderBucket, type RemoteCondition, type RemoteUpdate } from "./types.js";
import { resolveStatus, type StatusMapEntry } from "./mapping.js";

export type EventKind =
  | "submit_attempt" | "submitted" | "submit_failed" | "retry_scheduled" | "email_fallback" | "status_changed"
  | "offer_received" | "offer_updated" | "condition_added" | "condition_updated" | "document_uploaded"
  | "document_upload_failed" | "webhook_received" | "sync_failed" | "stage_moved" | "stage_not_moved" | "funded"
  | "balance_reported" | "checklist_updated";
export type EventSource = "api" | "webhook" | "poll" | "staff" | "system";

export async function logEvent(db: Q, e: {
  submissionId: string | null; applicationId: string; lenderId: string; kind: EventKind; source: EventSource;
  status?: string | null; detail?: string | null; data?: Record<string, unknown> | null; createdBy?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO lender_api_events (id, submission_id, application_id, lender_id, kind, source, status, detail, data, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())`,
    [randomUUID(), e.submissionId, e.applicationId, e.lenderId, e.kind, e.source, e.status ?? null, e.detail ? String(e.detail).slice(0, 2000) : null,
      e.data ? JSON.stringify(e.data) : null, e.createdBy ?? null],
  );
}

/** System actions (no person behind them) in the audit log. Best effort. */
export async function auditSystem(action: string, targetId: string | null, metadata: Record<string, unknown>): Promise<void> {
  try {
    await recordAuditEvent({ actorUserId: null, targetUserId: null, targetType: "lender_api", targetId, action, eventType: "lender_api", eventAction: action, success: true, metadata });
  } catch (err) {
    logWarnSwallowed(err, `lenderConnectors/sync.ts:audit:${action}`);
  }
}

/** Tells the application's assigned staff member (or every Admin when nobody is assigned). Best effort. */
export async function notifyStaff(db: Q, applicationId: string, n: { type: string; title: string; body: string; metadata?: Record<string, unknown> }): Promise<void> {
  try {
    const owner = await db.query(`SELECT owner_user_id::text AS owner FROM applications WHERE id::text = $1 LIMIT 1`, [applicationId]);
    let users: string[] = owner.rows[0]?.owner ? [String(owner.rows[0].owner)] : [];
    if (!users.length) {
      // Every Admin who works in the file's silo.
      const admins = await db.query(
        `SELECT u.id::text AS id FROM users u
          WHERE u.active = true AND upper(coalesce(u.role, '')) = 'ADMIN'
            AND (u.silo IS NULL OR upper(u.silo) = (SELECT upper(a.silo) FROM applications a WHERE a.id::text = $1)
                 OR (SELECT upper(a.silo) FROM applications a WHERE a.id::text = $1) = ANY(u.silos))`, [applicationId]);
      users = admins.rows.map((r: any) => String(r.id));
    }
    const contextUrl = `/applications/${encodeURIComponent(applicationId)}/lenders`;
    for (const userId of users) {
      await db.query(
        `INSERT INTO notifications (id, user_id, application_id, type, title, body, metadata, context_url, created_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now(), null)`,
        [randomUUID(), userId, applicationId, n.type, n.title, n.body, JSON.stringify(n.metadata ?? {}), contextUrl],
      );
      try {
        const { pushToUser } = await import("../services/notifications/pushToUser.js");
        void pushToUser(userId, n.title, n.body, contextUrl);
      } catch (err) {
        logWarnSwallowed(err, "lenderConnectors/sync.ts:push");
      }
    }
  } catch (err) {
    logWarnSwallowed(err, "lenderConnectors/sync.ts:notifyStaff");
  }
}

export type SubmissionRow = {
  id: string;
  application_id: string;
  lender_id: string;
  connector: string;
  external_id: string | null;
  lender_status: string | null;
  bucket: string | null;
};

export type ApplyResult = {
  statusChanged: boolean; bucket: LenderBucket | null; newOffers: number; newConditions: number; stageMoved: string | null;
  checklistAdded: number; balanceRecorded: boolean;
};

const CONTRACT_HISTORY_STATUSES = ["refinanced", "paid_out", "matured", "closed"];

/** Today's date in Alberta (YYYY-MM-DD). */
export function albertaToday(now = new Date()): string {
  return localDateIn(now, ALBERTA_TZ);
}

/**
 * BF_SERVER_v873_LENDER_API - follow-up from v865: a lender condition or document request goes onto the file's funding
 * conditions checklist once (linked by lender_api_conditions.funding_condition_id; an item with the same title already
 * on the checklist is linked instead of duplicated). When the lender later reports it satisfied or waived, an open
 * checklist item is cleared or waived to match. Staff own the item; a document request is marked as needing a document.
 */
export async function syncChecklistItem(db: Q, sub: SubmissionRow, lenderName: string, c: RemoteCondition, lenderConditionId: string,
  linkedId: string | null): Promise<"added" | "linked" | "cleared" | "waived" | null> {
  let fundingId = linkedId;
  let outcome: "added" | "linked" | "cleared" | "waived" | null = null;
  if (!fundingId) {
    const title = c.description.replace(/\s+/g, " ").trim().slice(0, 300) || "Lender condition";
    const same = await db.query(
      `SELECT id::text AS id FROM funding_conditions WHERE application_id = $1 AND lower(title) = lower($2) ORDER BY created_at LIMIT 1`,
      [sub.application_id, title]);
    if (same.rows[0]) {
      fundingId = String(same.rows[0].id);
      outcome = "linked";
    } else {
      const ins = await db.query(
        `INSERT INTO funding_conditions (application_id, title, description, owner, status, source, requires_document, note, position)
         VALUES ($1, $2, $3, 'staff', 'open', 'lender_api', $4, $5,
                 (SELECT COALESCE(max(position), 0) + 1 FROM funding_conditions WHERE application_id = $1))
         RETURNING id::text AS id`,
        [sub.application_id, title, c.documentType ? `Document: ${c.documentType}` : null, c.kind === "document_request",
          `From ${lenderName} by API`]);
      fundingId = String(ins.rows[0]?.id ?? "") || null;
      outcome = fundingId ? "added" : null;
    }
    if (fundingId) await db.query(`UPDATE lender_api_conditions SET funding_condition_id = $2::uuid WHERE id::text = $1`, [lenderConditionId, fundingId]);
  }
  if (fundingId && c.status !== "open") {
    const done = c.status === "waived"
      ? await db.query(
        `UPDATE funding_conditions SET status = 'waived', waived_at = now(), waived_reason = $2, updated_at = now()
          WHERE id::text = $1 AND status IN ('open','received') RETURNING id`, [fundingId, `Waived by ${lenderName}`.slice(0, 300)])
      : await db.query(
        `UPDATE funding_conditions SET status = 'cleared', cleared_at = now(), updated_at = now()
          WHERE id::text = $1 AND status IN ('open','received') RETURNING id`, [fundingId]);
    if (done.rows.length) outcome = c.status === "waived" ? "waived" : "cleared";
  }
  return outcome;
}

/**
 * BF_SERVER_v873_LENDER_API - follow-up from v866: a balance the lender reports on a funded deal is recorded on the
 * file's open Active Contract (recordLenderReportedBalance, source "lender_portal"). The same balance is not recorded
 * again unless the lender gives a newer as-of date. Returns false when the file has no open contract yet.
 */
export async function recordReportedBalance(db: Q, sub: SubmissionRow, lenderName: string, balance: number, asOfRaw: string | null | undefined,
  source: EventSource): Promise<boolean> {
  const asOf = /^\d{4}-\d{2}-\d{2}/.test(String(asOfRaw ?? "")) ? String(asOfRaw).slice(0, 10) : albertaToday();
  const c = await db.query(
    `SELECT id::text AS id FROM active_contracts
      WHERE application_id = $1 AND status <> ALL($3::text[]) AND (lender_id IS NULL OR lender_id::text = $2)
      ORDER BY created_at DESC LIMIT 1`, [sub.application_id, sub.lender_id, CONTRACT_HISTORY_STATUSES]);
  const contractId = c.rows[0]?.id ? String(c.rows[0].id) : null;
  if (!contractId) return false;
  const last = await db.query(
    `SELECT balance, as_of::text AS as_of FROM active_contract_balances
      WHERE contract_id = $1::uuid AND source = 'lender_portal' ORDER BY as_of DESC, created_at DESC LIMIT 1`, [contractId]);
  const prev = last.rows[0];
  if (prev && Number(prev.balance) === balance && (!asOfRaw || String(prev.as_of).slice(0, 10) >= asOf)) return false;
  const { recordLenderReportedBalance } = await import("../activeContracts/money.js");
  await recordLenderReportedBalance(db as any, contractId, balance, asOf, "lender_portal", { note: `Reported by ${lenderName} by API` });
  await logEvent(db, {
    submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "balance_reported", source,
    detail: `${lenderName} reports $${balance.toLocaleString("en-CA")} outstanding as of ${asOf}. Recorded on the Active Contract.`,
    data: { contract_id: contractId, balance, as_of: asOf },
  });
  return true;
}

/** Moves the application's pipeline stage when the move is a legal one; otherwise records why it did not. */
async function moveStage(db: Q, sub: SubmissionRow, stage: string, lenderName: string, source: EventSource): Promise<string | null> {
  try {
    const cur = await db.query(`SELECT pipeline_state FROM applications WHERE id::text = $1 LIMIT 1`, [sub.application_id]);
    const from = cur.rows[0]?.pipeline_state ?? null;
    if (!from || from === stage) return null;
    const { transitionPipelineState } = await import("../modules/applications/applications.service.js");
    const { isPipelineState } = await import("../modules/applications/pipelineState.js");
    if (!isPipelineState(stage)) {
      await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_not_moved", source, detail: `"${stage}" is not a pipeline stage.` });
      return null;
    }
    await transitionPipelineState({ applicationId: sub.application_id, nextState: stage, actorUserId: null, actorRole: null, trigger: "lender_api", reason: `${lenderName} status update` });
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_moved", source, status: stage, detail: `Moved from ${from} to ${stage}.` });
    return stage;
  } catch (err) {
    await logEvent(db, {
      submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "stage_not_moved", source, status: stage,
      detail: `Left the file where it is: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
    });
    return null;
  }
}

export async function applyRemoteUpdate(db: Q, args: {
  submission: SubmissionRow;
  lenderName: string;
  update: RemoteUpdate;
  source: EventSource;
  adminStatusMap: Record<string, StatusMapEntry>;
  connectorDefaults: Record<string, LenderBucket>;
  pollIntervalMinutes: number;
}): Promise<ApplyResult> {
  const { submission: sub, update, source, lenderName } = args;
  const result: ApplyResult = {
    statusChanged: false, bucket: (sub.bucket as LenderBucket | null) ?? null, newOffers: 0, newConditions: 0, stageMoved: null,
    checklistAdded: 0, balanceRecorded: false,
  };

  // ── status ──
  if (update.status && update.status !== sub.lender_status) {
    const resolved = resolveStatus(update.status, args.adminStatusMap, args.connectorDefaults);
    result.statusChanged = true;
    result.bucket = resolved.bucket;
    await logEvent(db, {
      submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "status_changed", source,
      status: update.status, detail: `${lenderName}: ${update.statusLabel || update.status} (${BUCKET_LABELS[resolved.bucket]})`,
      data: { from: sub.lender_status, to: update.status, bucket: resolved.bucket, mapped_by: resolved.source },
    });
    await notifyStaff(db, sub.application_id, {
      type: "lender_status", title: `${lenderName}: ${BUCKET_LABELS[resolved.bucket]}`,
      body: `${lenderName} moved this deal to "${update.statusLabel || update.status}".`,
      metadata: { lender_id: sub.lender_id, submission_id: sub.id, status: update.status, bucket: resolved.bucket },
    });
    await auditSystem("lender_status_changed", sub.application_id, { lender_id: sub.lender_id, from: sub.lender_status, to: update.status, bucket: resolved.bucket, source });
    if (resolved.stage) result.stageMoved = await moveStage(db, sub, resolved.stage, lenderName, source);
  }

  // ── offers ──
  for (const o of update.offers ?? []) {
    const existing = await db.query(`SELECT id::text AS id, amount, status FROM offers WHERE lender_id::text = $1 AND lender_external_id = $2 LIMIT 1`, [sub.lender_id, o.externalId]);
    const notes = [o.notes, `From ${lenderName} by API`].filter(Boolean).join(" · ");
    if (!existing.rows[0]) {
      await db.query(
        `INSERT INTO offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, status, notes, lender_id, lender_external_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, now(), now())
         ON CONFLICT DO NOTHING`,
        [randomUUID(), sub.application_id, lenderName, o.amount, o.rateFactor, o.term, o.paymentFrequency, /^\d{4}-\d{2}-\d{2}/.test(o.expiryDate ?? "") ? o.expiryDate!.slice(0, 10) : null, notes, sub.lender_id, o.externalId],
      );
      result.newOffers += 1;
      await logEvent(db, {
        submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "offer_received", source,
        detail: `${lenderName} offer${o.amount !== null ? ` of $${o.amount.toLocaleString("en-CA")}` : ""}${o.term ? `, ${o.term}` : ""}${o.rateFactor ? `, ${o.rateFactor}` : ""}`,
        data: { ...o },
      });
      await notifyStaff(db, sub.application_id, {
        type: "lender_offer", title: `New offer from ${lenderName}`,
        body: `${lenderName} sent an offer${o.amount !== null ? ` of $${o.amount.toLocaleString("en-CA")}` : ""}. It is in the Offers list.`,
        metadata: { lender_id: sub.lender_id, external_offer_id: o.externalId },
      });
    } else if (Number(existing.rows[0].amount ?? NaN) !== (o.amount ?? NaN)) {
      await db.query(
        `UPDATE offers SET amount = $1, rate_factor = $2, term = $3, payment_frequency = $4, updated_at = now()
          WHERE lender_id::text = $5 AND lender_external_id = $6`,
        [o.amount, o.rateFactor, o.term, o.paymentFrequency, sub.lender_id, o.externalId],
      );
      await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "offer_updated", source, detail: `${lenderName} changed an offer.`, data: { ...o } });
    }
  }

  // ── conditions and document requests ──
  for (const c of update.conditions ?? []) {
    const r = await db.query(
      `INSERT INTO lender_api_conditions (id, submission_id, application_id, lender_id, external_id, kind, description, document_type, status, first_seen_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
       ON CONFLICT (submission_id, external_id) DO UPDATE
         SET description = EXCLUDED.description, document_type = EXCLUDED.document_type, status = EXCLUDED.status, kind = EXCLUDED.kind,
             updated_at = CASE WHEN lender_api_conditions.status IS DISTINCT FROM EXCLUDED.status THEN now() ELSE lender_api_conditions.updated_at END
       RETURNING id::text AS id, (xmax = 0) AS inserted, status, funding_condition_id::text AS funding_condition_id`,
      [randomUUID(), sub.id, sub.application_id, sub.lender_id, c.externalId, c.kind, c.description.slice(0, 1000), c.documentType, c.status],
    );
    if (r.rows[0]?.inserted) {
      result.newConditions += 1;
      await logEvent(db, {
        submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "condition_added", source,
        detail: `${lenderName} ${c.kind === "document_request" ? "asked for a document" : "added a condition"}: ${c.description}`.slice(0, 500), data: { ...c },
      });
    }
    // The funding conditions checklist (v865).
    if (r.rows[0]?.id) {
      try {
        const done = await syncChecklistItem(db, sub, lenderName, c, String(r.rows[0].id), r.rows[0].funding_condition_id ?? null);
        if (done === "added") result.checklistAdded += 1;
        if (done && done !== "linked") {
          await logEvent(db, {
            submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "checklist_updated", source,
            detail: `${done === "added" ? "Added to" : done === "cleared" ? "Cleared on" : "Waived on"} the funding conditions checklist: ${c.description}`.slice(0, 500),
          });
        }
      } catch (err) {
        logWarnSwallowed(err, "lenderConnectors/sync.ts:checklist");
      }
    }
  }
  if (result.newConditions > 0) {
    await notifyStaff(db, sub.application_id, {
      type: "lender_conditions", title: `${lenderName} needs something`,
      body: `${lenderName} added ${result.newConditions} condition${result.newConditions === 1 ? "" : "s"} or document request${result.newConditions === 1 ? "" : "s"}. See the Lenders tab.`,
      metadata: { lender_id: sub.lender_id, submission_id: sub.id },
    });
  }

  // ── funding, commission and the balance afterwards ──
  if (update.fundedAmount !== undefined && update.fundedAmount !== null && result.bucket === "funded") {
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "funded", source, detail: `${lenderName} reports $${update.fundedAmount.toLocaleString("en-CA")} funded.`, data: { funded_amount: update.fundedAmount, commission_amount: update.commissionAmount ?? null } });
  }

  if (typeof update.balance === "number" && Number.isFinite(update.balance) && update.balance >= 0) {
    try {
      result.balanceRecorded = await recordReportedBalance(db, sub, lenderName, update.balance, update.balanceAsOf, source);
    } catch (err) {
      logWarnSwallowed(err, "lenderConnectors/sync.ts:balance");
    }
  }

  const bucket = result.bucket;
  // Declined / withdrawn deals stop polling; funded deals keep being polled (daily at most) for their balance.
  const terminal = stopsPolling(bucket);
  const pollMinutes = bucket === "funded" ? Math.max(FUNDED_POLL_MINUTES, args.pollIntervalMinutes) : Math.max(5, args.pollIntervalMinutes);
  await db.query(
    `UPDATE lender_api_submissions
        SET lender_status = COALESCE($2, lender_status), lender_status_label = COALESCE($3, lender_status_label), bucket = COALESCE($4, bucket),
            funded_amount = COALESCE($5, funded_amount), commission_amount = COALESCE($6, commission_amount),
            linked_record_id = COALESCE($7, linked_record_id), last_synced_at = now(),
            next_poll_at = CASE WHEN $8 THEN NULL ELSE now() + ($9 || ' minutes')::interval END, updated_at = now()
      WHERE id = $1`,
    [sub.id, update.status ?? null, update.statusLabel ?? null, bucket, update.fundedAmount ?? null, update.commissionAmount ?? null, update.linkedRecordId ?? null, terminal, String(pollMinutes)],
  );
  return result;
}
