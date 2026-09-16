// BF_SERVER_PRODUCT_QUESTIONS_GATE_v289
// Todd's rule: an application cannot go to lenders until every product question
// for its category is answered by the client. Enforced at each send route (so
// staff get a clear reason) and inside dispatchToSelected and submitApplication
// (the choke points every automatic path runs through).
import { AppError } from "../../middleware/errors.js";
import { loadGaps } from "./service.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows?: any[]; rowCount?: number | null }>;

export type ProductQuestionsSummary = {
  set: string | null;
  setLabel: string | null;
  missingCount: number;
  submittedAt: string | null;
  blocking: boolean;
  message: string | null;
};

export function summaryMessage(setLabel: string | null, missingCount: number): string | null {
  if (!missingCount) return null;
  return `Waiting on client: ${missingCount} ${setLabel ?? "product"} question${missingCount === 1 ? "" : "s"} still need answers before this can be sent to lenders.`;
}

export async function productQuestionsSummary(query: Query, applicationId: string): Promise<ProductQuestionsSummary> {
  const gaps = await loadGaps(query as any, applicationId);
  const missingCount = gaps?.missing.length ?? 0;
  return {
    set: gaps?.set ?? null,
    setLabel: gaps?.setLabel ?? null,
    missingCount,
    submittedAt: gaps?.submittedAt ?? null,
    blocking: missingCount > 0,
    message: summaryMessage(gaps?.setLabel ?? null, missingCount),
  };
}

export class ProductQuestionsIncompleteError extends AppError {
  constructor(public readonly summary: ProductQuestionsSummary) {
    super("product_questions_incomplete", summary.message ?? "Product questions are incomplete.", 409);
  }
}

export async function assertProductQuestionsAnswered(query: Query, applicationId: string): Promise<void> {
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
