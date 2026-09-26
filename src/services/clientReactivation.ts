// BF_SERVER_BLOCK_v547_CLIENT_REACTIVATE
// A client whose file staff put on Hold can bring it back from the portal. The
// file goes to In Review (not the stage it was parked from) so staff look at it
// again before anything else happens. Only Hold qualifies: a Fraud file answers
// exactly like any other non-held file, so the client learns nothing from it.
import { ApplicationStage } from "../modules/applications/pipelineState.js";

export type ReactivateResult =
  | { ok: true }
  | { ok: false; error: "not_on_hold" };

export type ReactivateDeps = {
  // Atomically clears the hold only if the file is STILL on Hold; true if it did.
  claim: (applicationId: string) => Promise<boolean>;
  moveToInReview: (applicationId: string) => Promise<void>;
  tellStaff: (applicationId: string) => Promise<void>;
};

export async function reactivateHeldApplication(
  applicationId: string,
  deps: ReactivateDeps = defaultDeps,
): Promise<ReactivateResult> {
  if (!(await deps.claim(applicationId))) return { ok: false, error: "not_on_hold" };
  await deps.moveToInReview(applicationId);
  // Staff notice is best-effort: the file is already back in review.
  await deps.tellStaff(applicationId).catch((err: any) =>
    console.warn("[client-reactivate] staff_notice_failed", { applicationId, message: err?.message }));
  return { ok: true };
}

const defaultDeps: ReactivateDeps = {
  async claim(applicationId) {
    const { pool } = await import("../db.js");
    const r = await pool.query(
      `UPDATE applications
          SET parked_previous_stage = NULL, parked_at = NULL, parked_by = NULL,
              parked_reason = NULL, updated_at = now()
        WHERE id::text = ($1)::text AND pipeline_state = $2
        RETURNING id`,
      [applicationId, ApplicationStage.HOLD],
    );
    return (r.rowCount ?? 0) > 0;
  },
  async moveToInReview(applicationId) {
    const { transitionPipelineState } = await import("../modules/applications/applications.service.js");
    await transitionPipelineState({
      applicationId,
      nextState: ApplicationStage.IN_REVIEW,
      actorUserId: null,
      actorRole: null,
      trigger: "client_reactivated",
      reason: "Client reactivated the file from the portal",
    });
  },
  async tellStaff(applicationId) {
    const { pool } = await import("../db.js");
    const { randomUUID } = await import("node:crypto");
    // Shows in the file's thread (staff side) as a client message.
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, created_at)
       VALUES ($1, 'message', 'inbound', 'received', $2,
         (SELECT contact_id FROM applications WHERE id::text = ($2)::text LIMIT 1),
         COALESCE((SELECT silo FROM applications WHERE id::text = ($2)::text LIMIT 1), 'BF'),
         $3, now())`,
      [randomUUID(), applicationId, "I've reactivated this file - it is back in review."],
    );
    const { sendStaffNotification } = await import("./notifications/staffSms.js");
    await sendStaffNotification({
      recipients: "available",
      body: `Client reactivated an on-hold file (app ${applicationId.slice(0, 8)}) - now In Review.`,
    });
  },
};
