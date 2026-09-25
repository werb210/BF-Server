// BF_SERVER_PRODUCT_QUESTIONS_GATE_v289
// Todd's rule: an application cannot go to lenders until every product question
// for its category is answered by the client. Enforced at each send route (so
// staff get a clear reason) and inside dispatchToSelected and submitApplication
// (the choke points every automatic path runs through).
import { AppError } from "../../middleware/errors.js";
import { assertBrokerDealConfirmed } from "../brokerImport/dealGate.js"; // BF_SERVER_BLOCK_v521_BROKER_IMPORT
import { loadGaps } from "./service.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null }>;

export type ProductQuestionsSummary = {
  set: string | null;
  setLabel: string | null;
  missingCount: number;
  submittedAt: string | null;
  blocking: boolean;
  message: string | null;
  resignRequired: boolean; // v293
};

export function summaryMessage(setLabel: string | null, missingCount: number): string | null {
  if (!missingCount) return null;
  return `Waiting on client: ${missingCount} ${setLabel ?? "product"} question${missingCount === 1 ? "" : "s"} still need answers before this can be sent to lenders.`;
}

// BF_SERVER_PRODUCT_SWITCH_RESIGN_v293
// The Accord credit application is built from the Line of Credit answers and is
// part of what the client signs. If the client signed before the switch to Line
// of Credit, or staff corrected an answer after they signed, the signed package
// does not contain what is being sent, so it has to be signed again.
export function resignNeeded(input: { set: string | null; signedAt: unknown; history: unknown; progress: unknown }): boolean {
  if (input.set !== "loc_accord" || !input.signedAt) return false;
  const signed = new Date(String(input.signedAt)).getTime();
  if (!Number.isFinite(signed)) return false;
  const times: number[] = [];
  const history = Array.isArray(input.history) ? input.history : [];
  for (const h of history) {
    if (h && /LINE_OF_CREDIT|^LOC$/i.test(String((h as any).to ?? ""))) times.push(new Date(String((h as any).at)).getTime());
  }
  const progress = (input.progress && typeof input.progress === "object" ? (input.progress as any).loc_accord : null) ?? {};
  if (progress.submitted_at) times.push(new Date(String(progress.submitted_at)).getTime());
  for (const e of Array.isArray(progress.staff_edits) ? progress.staff_edits : []) times.push(new Date(String(e?.at)).getTime());
  return times.some((t) => Number.isFinite(t) && t > signed);
}

export async function productQuestionsSummary(query: Query, applicationId: string): Promise<ProductQuestionsSummary> {
  const gaps = await loadGaps(query as any, applicationId);
  const missingCount = gaps?.missing.length ?? 0;
  const sig = await query(
    `SELECT signnow_app_signed_at AS signed_at, metadata->'product_category_history' AS history, metadata->'product_questions' AS progress
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const row = sig.rows?.[0];
  const resignRequired = !!row && resignNeeded({ set: gaps?.set ?? null, signedAt: row.signed_at, history: row.history, progress: row.progress });
  const message = summaryMessage(gaps?.setLabel ?? null, missingCount)
    ?? (resignRequired ? `Waiting on client signature: the ${gaps?.setLabel} details changed after the client signed. Ask the client to sign the updated application before sending to lenders.` : null);
  return {
    set: gaps?.set ?? null,
    setLabel: gaps?.setLabel ?? null,
    missingCount,
    submittedAt: gaps?.submittedAt ?? null,
    blocking: missingCount > 0 || resignRequired,
    message,
    resignRequired,
  };
}

/** Archives the old signature, clears it so a new signing package (with the Accord form) is built, and asks the client to sign. */
export async function requestResignature(query: Query, applicationId: string, by: string | null): Promise<{ ok: boolean; reason?: string }> {
  const summary = await productQuestionsSummary(query, applicationId);
  if (summary.missingCount > 0) return { ok: false, reason: "questions_incomplete" };
  if (!summary.resignRequired) return { ok: false, reason: "not_required" };
  await query(
    `UPDATE applications
        SET metadata = (COALESCE(metadata, '{}'::jsonb) - 'signnow_embedded')
                       || jsonb_build_object('signing_history',
                            COALESCE(metadata->'signing_history', '[]'::jsonb)
                            || jsonb_build_array(jsonb_build_object('signed_at', signnow_app_signed_at, 'document_id', signnow_document_id, 'reset_at', now(), 'reset_by', $2::text, 'reason', 'product_category_changed'))),
            signnow_app_signed_at = NULL,
            signnow_document_id = NULL,
            submission_chain_started_at = NULL,
            updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId, by],
  );
  await query(
    `INSERT INTO communications_messages
       (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
     SELECT gen_random_uuid(), 'message', 'outbound', 'sent', a.id, a.contact_id, COALESCE(a.silo, 'BF'),
            $2, 'Boreal Financial', 'Sign now', 'sign', now()
       FROM applications a WHERE a.id::text = ($1)::text`,
    [applicationId, `Your application has been updated to ${summary.setLabel}. Please sign the updated application so we can send it to lenders.`],
  );
  const { notifyApplicant } = await import("../push/applicantPush.js");
  void notifyApplicant({ applicationId, categoryId: "APPLICATION_UPDATE", title: "Please sign your updated application", body: `Your ${summary.setLabel} application is ready to sign.`, dedupeKey: "product_switch_resign" });
  return { ok: true };
}

/** Tells staff the client finished the questions (and whether a new signature is still needed). */
export async function notifyStaffQuestionsAnswered(query: Query, applicationId: string): Promise<void> {
  try {
    const summary = await productQuestionsSummary(query, applicationId);
    const app = (await query(`SELECT name FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId])).rows?.[0];
    const { createNotification } = await import("../../modules/notifications/notifications.repo.js");
    const { randomUUID } = await import("node:crypto");
    await createNotification({
      notificationId: randomUUID(),
      userId: null,
      applicationId,
      type: "PRODUCT_QUESTIONS_ANSWERED",
      title: `Client answered the ${summary.setLabel ?? "product"} questions`,
      body: `${app?.name ?? "The application"}: ${summary.resignRequired ? "answers are in. Ask the client to sign the updated application before sending." : "answers are in and it can now be sent to lenders."}`,
      metadata: { audience: "staff", set: summary.set, resignRequired: summary.resignRequired },
    });
  } catch (err) {
    console.error(JSON.stringify({ event: "product_questions_notify_failed", applicationId, message: err instanceof Error ? err.message : String(err) }));
  }
}

export class ProductQuestionsIncompleteError extends AppError {
  constructor(public readonly summary: ProductQuestionsSummary) {
    super("product_questions_incomplete", summary.message ?? "Product questions are incomplete.", 409);
  }
}

export async function assertProductQuestionsAnswered(query: Query, applicationId: string): Promise<void> {
  await assertBrokerDealConfirmed(query, applicationId);
  const summary = await productQuestionsSummary(query, applicationId);
  if (summary.blocking) throw new ProductQuestionsIncompleteError(summary);
}

/** Posts the CMP message (with an answer button) and a push, once per set until answered. */
export async function requestProductQuestions(query: Query, applicationId: string): Promise<ProductQuestionsSummary> {
  const summary = await productQuestionsSummary(query, applicationId);
  if (!summary.blocking || !summary.set) return summary;
  const body = `We need a few more details for your ${summary.setLabel} application. Please answer ${summary.missingCount} question${summary.missingCount === 1 ? "" : "s"} so we can send it to lenders.`;
  const inserted = await query(
    `INSERT INTO communications_messages
       (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
     SELECT gen_random_uuid(), 'message', 'outbound', 'sent', a.id, a.contact_id, COALESCE(a.silo, 'BF'), $2, 'Boreal Financial',
            'Answer questions', $3, now()
       FROM applications a
      WHERE a.id::text = ($1)::text
        AND NOT EXISTS (
          SELECT 1 FROM communications_messages m
           WHERE m.application_id::text = ($1)::text AND m.cta_action = $3
             AND m.created_at > COALESCE((a.metadata->'product_questions'->$4->>'submitted_at')::timestamptz, 'epoch'::timestamptz)
        )
     RETURNING id`,
    [applicationId, body, `product_questions:${summary.set}`, summary.set],
  );
  if ((inserted.rows?.length ?? 0) > 0) {
    const { notifyApplicant } = await import("../push/applicantPush.js");
    void notifyApplicant({
      applicationId,
      categoryId: "APPLICATION_UPDATE",
      title: "A few more questions",
      body: `Please answer ${summary.missingCount} question${summary.missingCount === 1 ? "" : "s"} for your ${summary.setLabel} application.`,
      dedupeKey: `product_questions:${summary.set}`,
    });
  }
  return summary;
}
