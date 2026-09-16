// BF_SERVER_CALL_OUTCOME_CRM_v273
// A call outcome now updates the contact record itself, not just a note and a
// task. Until now "do not contact" returned suppressOutreach:true and changed
// nothing: the contact stayed in sequences and could still be texted.
//
// Rules (HubSpot lead-status vocabulary):
//   no answer / left voicemail      -> "Attempted to contact"  (only from New/Open)
//   any conversation outcome        -> "Connected"             (only from New/Open/Attempted)
//   not interested                  -> "Unqualified" and active sequences stopped
//   do not contact                  -> "Do not contact", marketing email and SMS
//                                      turned off, active sequences stopped
// Early statuses are the only ones overwritten automatically, so a contact
// staff already marked Qualified or In progress is never downgraded by a call.
// Stage moves, meetings and document requests need a staff choice (which stage,
// what time, which documents) and are not automatic.

export type DispositionCrmRule = {
  leadStatus: string | null;
  onlyFrom: string[] | null;
  stopSequences: boolean;
  optOut: boolean;
};

const EARLY = ["New", "Open"];

export const DISPOSITION_CRM_RULES: Readonly<Record<string, DispositionCrmRule>> = {
  no_answer: { leadStatus: "Attempted to contact", onlyFrom: EARLY, stopSequences: false, optOut: false },
  left_voicemail: { leadStatus: "Attempted to contact", onlyFrom: EARLY, stopSequences: false, optOut: false },
  connected: { leadStatus: "Connected", onlyFrom: [...EARLY, "Attempted to contact"], stopSequences: false, optOut: false },
  follow_up: { leadStatus: "Connected", onlyFrom: [...EARLY, "Attempted to contact"], stopSequences: false, optOut: false },
  demo_booked: { leadStatus: "Connected", onlyFrom: [...EARLY, "Attempted to contact"], stopSequences: false, optOut: false },
  documents_promised: { leadStatus: "Connected", onlyFrom: [...EARLY, "Attempted to contact"], stopSequences: false, optOut: false },
  needs_lender_review: { leadStatus: "Connected", onlyFrom: [...EARLY, "Attempted to contact"], stopSequences: false, optOut: false },
  not_interested: { leadStatus: "Unqualified", onlyFrom: null, stopSequences: true, optOut: false },
  do_not_contact: { leadStatus: "Do not contact", onlyFrom: null, stopSequences: true, optOut: true },
};

export type DispositionCrmResult = { leadStatus: string | null; sequencesStopped: number; optedOut: boolean };

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export async function applyDispositionCrmUpdate(contactId: string, disposition: string, query: Query): Promise<DispositionCrmResult> {
  const rule = DISPOSITION_CRM_RULES[disposition];
  const result: DispositionCrmResult = { leadStatus: null, sequencesStopped: 0, optedOut: false };
  if (!rule) return result;

  if (rule.leadStatus) {
    const r = await query(
      `UPDATE contacts SET lead_status = $2, updated_at = now()
        WHERE id = $1::uuid
          AND ($3::text[] IS NULL OR COALESCE(NULLIF(lead_status, ''), 'New') = ANY($3::text[]))
        RETURNING lead_status`,
      [contactId, rule.leadStatus, rule.onlyFrom],
    );
    if (r.rows.length) result.leadStatus = r.rows[0].lead_status ?? rule.leadStatus;
  }
  if (rule.optOut) {
    await query(`UPDATE contacts SET marketing_opt_out = true, sms_opt_out = true, updated_at = now() WHERE id = $1::uuid`, [contactId]);
    result.optedOut = true;
  }
  if (rule.stopSequences) {
    const r = await query(
      `UPDATE marketing_sequence_enrollments SET status = $2, updated_at = now()
        WHERE contact_id = $1::uuid AND status IN ('active', 'running', 'paused')
        RETURNING id`,
      [contactId, `stopped_${disposition}`],
    );
    result.sequencesStopped = r.rows.length;
  }
  return result;
}

/** Appended to the timeline note so staff can see what the outcome changed. */
export function describeCrmUpdate(r: DispositionCrmResult): string {
  const parts: string[] = [];
  if (r.leadStatus) parts.push(`lead status set to ${r.leadStatus}`);
  if (r.optedOut) parts.push("marketing email and SMS turned off");
  if (r.sequencesStopped) parts.push(`${r.sequencesStopped} sequence${r.sequencesStopped === 1 ? "" : "s"} stopped`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}

/** Best-effort wrapper for the routes: a CRM update failure never fails the disposition. */
export async function safeDispositionCrmUpdate(contactId: string | null | undefined, disposition: string, query: Query): Promise<DispositionCrmResult | null> {
  if (!contactId) return null;
  try {
    return await applyDispositionCrmUpdate(contactId, disposition, query);
  } catch (err) {
    console.error(JSON.stringify({ event: "call_outcome_crm_update_failed", contactId, disposition, message: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
