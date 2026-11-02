// BF_SERVER_v873_LENDER_API - sending the lender package by API.
//
// Two ways in:
//   * the normal Send (orchestrator -> dispatchToSelected): a selected lender with an enabled connection set to
//     "submit by API" gets the package through its connector instead of the email. If the API refuses or cannot be
//     reached and the connection allows it, the package goes by email straight away (email stays the fallback) and
//     the log says so; without the fallback a retryable failure is retried by the lender-sync worker.
//   * "Submit by API" on the Lenders tab (submitByApiToLender): one lender, on demand - for a lender that already
//     had the package by email, or to retry. Same holds as a normal send (signed application, SBA forms, fraud hold,
//     product questions), same dispatch lock.
import type { Pool } from "pg";
import type { Q } from "../settingsPack/common.js";
import { connectorFor } from "./registry.js";
import { lenderHttp } from "./http.js";
import { loadConnectionByLender, openSecrets, type ConnectionRow } from "./store.js";
import { applyRemoteUpdate, auditSystem, logEvent, notifyStaff, type EventSource, type SubmissionRow } from "./sync.js";
import type { LenderPackage, PackageAttachment } from "./types.js";
import { packageValues, type StatusMapEntry } from "./mapping.js";

export const MAX_SUBMIT_ATTEMPTS = 5;

/** 2, 4, 8, 16 minutes ... capped at 2 hours. */
export function retryDelayMinutes(attempts: number): number {
  return Math.min(120, 2 ** Math.max(1, attempts));
}

export type UsableConnection = { connection: ConnectionRow; reason: null } | { connection: ConnectionRow | null; reason: string };

/** The lender's connection when it can send right now, or why not. */
export async function usableConnection(db: Q, lenderId: string): Promise<UsableConnection> {
  const connection = await loadConnectionByLender(db, lenderId);
  if (!connection) return { connection: null, reason: "no_connection" };
  if (!connection.enabled) return { connection, reason: "connection_off" };
  const connector = connectorFor(connection.connector);
  if (!connector) return { connection, reason: "unknown_connector" };
  if (connector.availability !== "available") return { connection, reason: connector.availability };
  if (!connector.capabilities.submit) return { connection, reason: "connector_cannot_submit" };
  return { connection, reason: null };
}

type FieldRow = { label: string; value: string | number | boolean | null };

/** The connector's view of the package dispatchToSelected built for this lender. */
export async function buildLenderPackage(pool: Pool, args: {
  applicationId: string; lenderId: string; lenderName: string; fields: FieldRow[];
  signedApplicationPdf: Buffer | null; additionalSignedDocs: Array<{ filename: string; content: Buffer }>;
  creditSummaryPdf: Buffer | null; documents: Array<{ category: string; files: Array<{ filename: string; content: Buffer }> }>;
}): Promise<LenderPackage> {
  const { loadSheetRowData } = await import("../modules/submissions/merchantGrowthSheet.js");
  const row = await loadSheetRowData(pool, args.applicationId);
  const owner = await pool.query<{ email: string | null }>(
    `SELECT u.email FROM applications a JOIN users u ON u.id = a.owner_user_id WHERE a.id::text = $1 LIMIT 1`, [args.applicationId],
  );
  const { brandName } = await import("../settingsPack/boreal.js");
  const typeFor = (name: string) => (/\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : "application/octet-stream");
  const attachments: PackageAttachment[] = [
    ...(args.signedApplicationPdf ? [{ filename: `application-${args.applicationId}.pdf`, contentType: "application/pdf", category: "Signed application", content: args.signedApplicationPdf }] : []),
    ...args.additionalSignedDocs.map((d) => ({ filename: d.filename, contentType: typeFor(d.filename), category: "Signed documents", content: d.content })),
    ...(args.creditSummaryPdf ? [{ filename: `credit-summary-${args.applicationId}.pdf`, contentType: "application/pdf", category: "Credit summary", content: args.creditSummaryPdf }] : []),
    ...args.documents.flatMap((g) => g.files.map((f) => ({ filename: f.filename, contentType: typeFor(f.filename), category: g.category, content: f.content }))),
  ];
  return {
    applicationId: args.applicationId, lenderId: args.lenderId, lenderName: args.lenderName,
    values: packageValues(row, args.fields, { brokerName: brandName(), brokerEmail: owner.rows[0]?.email ?? null }),
    attachments, submittedAt: new Date().toISOString(),
  };
}

export type ConnectorSubmitOutcome = { ok: true; externalId: string | null; warnings: string[] } | { ok: false; error: string; retryable: boolean; willRetry: boolean };

/** Sends through the connector and records everything: the submission row, the log, retries, notification, audit. */
export async function submitViaConnector(db: Q, args: {
  connection: ConnectionRow; pkg: LenderPackage; actorUserId: string | null; source: EventSource; emailFallbackAvailable: boolean;
}): Promise<ConnectorSubmitOutcome> {
  const { connection, pkg } = args;
  const connector = connectorFor(connection.connector)!;
  const up = await db.query(
    `INSERT INTO lender_api_submissions (id, application_id, lender_id, connection_id, connector, status, attempts, submitted_by, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'sending', 1, $5, now(), now())
     ON CONFLICT (application_id, lender_id) DO UPDATE
       SET status = 'sending', attempts = lender_api_submissions.attempts + 1, connection_id = EXCLUDED.connection_id,
           connector = EXCLUDED.connector, submitted_by = COALESCE(EXCLUDED.submitted_by, lender_api_submissions.submitted_by), updated_at = now()
     RETURNING id::text AS id, attempts`,
    [pkg.applicationId, pkg.lenderId, connection.id, connection.connector, args.actorUserId],
  );
  const submissionId = String(up.rows[0]?.id ?? "");
  const attempts = Number(up.rows[0]?.attempts ?? 1);
  await logEvent(db, { submissionId, applicationId: pkg.applicationId, lenderId: pkg.lenderId, kind: "submit_attempt", source: args.source, detail: `Attempt ${attempts} via ${connector.label}`, createdBy: args.actorUserId, data: { attachments: pkg.attachments.length } });

  let result;
  try {
    result = await connector.submitApplication({ config: connection.config ?? {}, secrets: openSecrets(connection.secrets_encrypted), http: lenderHttp() }, pkg);
  } catch (err) {
    result = { ok: false as const, error: err instanceof Error ? err.message : String(err), retryable: true };
  }

  if (result.ok) {
    await db.query(
      `UPDATE lender_api_submissions
          SET status = 'submitted', external_id = COALESCE($2, external_id), submitted_at = now(), next_retry_at = NULL, last_error = NULL,
              warnings = $3::jsonb, next_poll_at = CASE WHEN $2 IS NULL THEN NULL ELSE now() + ($4 || ' minutes')::interval END, updated_at = now()
        WHERE id::text = $1`,
      [submissionId, result.externalId, JSON.stringify(result.warnings ?? []), String(Math.max(5, connection.poll_interval_minutes ?? 30))],
    );
    await logEvent(db, {
      submissionId, applicationId: pkg.applicationId, lenderId: pkg.lenderId, kind: "submitted", source: args.source, status: result.status,
      detail: `${pkg.lenderName} accepted the package${result.externalId ? ` (their id ${result.externalId})` : ""}.${result.warnings?.length ? ` Warnings: ${result.warnings.join(" ")}` : ""}`.slice(0, 2000),
      createdBy: args.actorUserId, data: { external_id: result.externalId, warnings: result.warnings ?? [] },
    });
    await auditSystem("lender_api_submitted", pkg.applicationId, { lender_id: pkg.lenderId, connector: connection.connector, external_id: result.externalId, actor: args.actorUserId, source: args.source });
    if (result.status) {
      const sub: SubmissionRow = { id: submissionId, application_id: pkg.applicationId, lender_id: pkg.lenderId, connector: connection.connector, external_id: result.externalId, lender_status: null, bucket: null };
      await applyRemoteUpdate(db, {
        submission: sub, lenderName: pkg.lenderName, update: { externalId: result.externalId ?? "", status: result.status }, source: "api",
        adminStatusMap: (connection.status_map ?? {}) as Record<string, StatusMapEntry>, connectorDefaults: connector.defaultStatusMap(connection.config ?? {}),
        pollIntervalMinutes: connection.poll_interval_minutes ?? 30,
      });
    }
    return { ok: true, externalId: result.externalId, warnings: result.warnings ?? [] };
  }

  const willRetry = result.retryable && !args.emailFallbackAvailable && attempts < MAX_SUBMIT_ATTEMPTS;
  await db.query(
    `UPDATE lender_api_submissions
        SET status = $2, last_error = $3, next_retry_at = CASE WHEN $4 THEN now() + ($5 || ' minutes')::interval ELSE NULL END, updated_at = now()
      WHERE id::text = $1`,
    [submissionId, willRetry ? "retrying" : "failed", result.error.slice(0, 1000), willRetry, String(retryDelayMinutes(attempts))],
  );
  await logEvent(db, { submissionId, applicationId: pkg.applicationId, lenderId: pkg.lenderId, kind: "submit_failed", source: args.source, detail: result.error, createdBy: args.actorUserId, data: { retryable: result.retryable, attempts } });
  if (willRetry) await logEvent(db, { submissionId, applicationId: pkg.applicationId, lenderId: pkg.lenderId, kind: "retry_scheduled", source: "system", detail: `Trying again in ${retryDelayMinutes(attempts)} minutes (attempt ${attempts + 1} of ${MAX_SUBMIT_ATTEMPTS}).` });
  await auditSystem("lender_api_submit_failed", pkg.applicationId, { lender_id: pkg.lenderId, connector: connection.connector, error: result.error.slice(0, 300), attempts, will_retry: willRetry });
  if (!willRetry && !args.emailFallbackAvailable) {
    await notifyStaff(db, pkg.applicationId, {
      type: "lender_api_failed", title: `${pkg.lenderName} did not take the package`,
      body: `Sending by API to ${pkg.lenderName} failed: ${result.error.slice(0, 200)}`, metadata: { lender_id: pkg.lenderId, submission_id: submissionId },
    });
  }
  return { ok: false, error: result.error, retryable: result.retryable, willRetry };
}

/** Records that the package went by email after the API failed. */
export async function recordEmailFallback(db: Q, applicationId: string, lenderId: string, lenderName: string, apiError: string, emailOk: boolean): Promise<void> {
  const r = await db.query(
    `UPDATE lender_api_submissions SET status = $3, next_retry_at = NULL, updated_at = now()
      WHERE application_id = $1 AND lender_id::text = $2 RETURNING id::text AS id`,
    [applicationId, lenderId, emailOk ? "sent_by_email" : "failed"],
  );
  await logEvent(db, {
    submissionId: r.rows[0]?.id ?? null, applicationId, lenderId, kind: "email_fallback", source: "system",
    detail: emailOk ? `The API did not take it (${apiError.slice(0, 200)}), so the package went to ${lenderName} by email.` : `The API did not take it and the email fallback failed too.`,
  });
  await notifyStaff(db, applicationId, {
    type: "lender_api_fallback", title: emailOk ? `${lenderName}: sent by email instead` : `${lenderName}: package not sent`,
    body: emailOk ? `The API refused or could not be reached, so the package went by email. ${apiError.slice(0, 160)}` : `Neither the API nor the email reached ${lenderName}. ${apiError.slice(0, 160)}`,
    metadata: { lender_id: lenderId },
  });
}

export type ManualSubmitResult = { ok: true; externalId: string | null; warnings: string[] } | { ok: false; reason: string; detail?: string };

/** "Submit by API" on the Lenders tab, and the worker's retries. */
export async function submitByApiToLender(pool: Pool, applicationId: string, lenderId: string, actorUserId: string | null): Promise<ManualSubmitResult> {
  const db = pool as unknown as Q;
  const usable = await usableConnection(db, lenderId);
  if (usable.reason) return { ok: false, reason: usable.reason };
  const { readReadinessSnapshot } = await import("../services/submission/orchestrator.js");
  const snap = await readReadinessSnapshot({ pool, applicationId });
  if (!snap.applicationSigned) return { ok: false, reason: "application_not_signed" };
  const { sbaPackageBlocker } = await import("../signnow/sba/sbaPackageReadiness.js");
  const block = await sbaPackageBlocker(applicationId);
  if (block) return { ok: false, reason: block.reason, ...(block.detail ? { detail: block.detail } : {}) };
  const lender = await pool.query<{ lender_id: string; name: string; submission_method: string | null; submission_email: string | null; api_endpoint: string | null; api_key_encrypted: string | null; google_sheet_id: string | null; google_sheet_tab: string | null }>(
    `SELECT l.id::text AS lender_id, l.name, l.submission_method, l.submission_email, l.api_endpoint, l.api_key_encrypted, l.google_sheet_id, l.google_sheet_tab
       FROM lenders l WHERE l.id::text = $1 LIMIT 1`, [lenderId],
  );
  if (!lender.rows[0]) return { ok: false, reason: "lender_not_found" };
  const claim = await pool.query<{ id: string }>(
    `UPDATE applications SET submission_packages_started_at = NOW()
      WHERE id::text = $1 AND (submission_packages_started_at IS NULL OR submission_packages_started_at < NOW() - interval '10 minutes')
      RETURNING id`, [applicationId],
  );
  if (!claim.rows.length) return { ok: false, reason: "dispatch_in_progress" };
  try {
    const { dispatchToSelected } = await import("../services/lenders/dispatchToSelected.js");
    const sent = (await dispatchToSelected({ pool, applicationId }, [lender.rows[0]], { forceConnector: true, actorUserId })) ?? [];
    const sub = await pool.query<{ external_id: string | null; warnings: string[] | null; last_error: string | null }>(
      `SELECT external_id, warnings, last_error FROM lender_api_submissions WHERE application_id = $1 AND lender_id::text = $2 LIMIT 1`, [applicationId, lenderId],
    );
    if (!sent.length) return { ok: false, reason: "api_submit_failed", ...(sub.rows[0]?.last_error ? { detail: sub.rows[0].last_error.slice(0, 300) } : {}) };
    // A first send moves the file to Off to Lender, exactly as the normal Send does.
    await pool.query(
      `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now()
        WHERE id::text = $1 AND pipeline_state NOT IN ('Off to Lender','Offer','Accepted','Rejected','Declined','Funded','Closed','Fraud','Hold')`,
      [applicationId],
    );
    return { ok: true, externalId: sub.rows[0]?.external_id ?? null, warnings: Array.isArray(sub.rows[0]?.warnings) ? sub.rows[0]!.warnings! : [] };
  } catch (err) {
    return { ok: false, reason: "dispatch_failed", detail: err instanceof Error ? err.message.slice(0, 200) : undefined };
  } finally {
    await pool.query(`UPDATE applications SET submission_packages_started_at = NULL WHERE id::text = $1`, [applicationId])
      .catch((err: unknown) => { console.warn("[lender_api] lock release failed", { applicationId, message: err instanceof Error ? err.message : String(err) }); });
  }
}
