// BF_SERVER_FRAUD_ENFORCE_v50
// A fraud stage that only changes a number on a dashboard is not a control.
// Once an application is parked in Fraud it must stop moving: no lender ever
// receives the package, the applicant cannot keep working the file, and no
// automated message goes out to the contact.
//
// Nothing is deleted. The application, its documents, its timeline and its
// messages all stay exactly as they are; only forward motion stops. Restoring
// the file out of Fraud (BF_SERVER_PARK_RESTORE_v49) lifts every block here.

import type { Pool } from "pg";
import { ApplicationStage } from "../../modules/applications/pipelineState.js";

export const FRAUD_LOCK_MESSAGE =
  "This application is marked as fraud and is locked. Documents and history are retained, but it cannot be submitted, edited or messaged until a manager reactivates it.";

export type MinimalPool = Pick<Pool, "query">;

export async function isApplicationFraud(
  pool: MinimalPool,
  applicationId: string | null | undefined,
): Promise<boolean> {
  const id = String(applicationId ?? "").trim();
  if (!id) return false;
  try {
    // BF_SERVER_FRAUD_GUARD_ROWS_v53 - read the stage back and compare it, rather
    // than inferring fraud from rowCount. A stubbed pool returning a canned
    // result would otherwise mark every application fraudulent.
    const r = await pool.query(
      `SELECT pipeline_state FROM applications
        WHERE id::text = ($1)::text LIMIT 1`,
      [id],
    );
    const stage = (r.rows ?? [])[0]?.pipeline_state;
    return String(stage ?? "") === ApplicationStage.FRAUD;
  } catch {
    return false;
  }
}

export async function contactHasFraudApplication(
  pool: MinimalPool,
  contactId: string | null | undefined,
): Promise<boolean> {
  const id = String(contactId ?? "").trim();
  if (!id) return false;
  try {
    const r = await pool.query(
      `SELECT a.id AS fraud_application_id
         FROM applications a
        WHERE a.pipeline_state = $2
          AND (
            a.contact_id::text = ($1)::text
            OR EXISTS (
              SELECT 1 FROM application_contacts ac
               WHERE ac.application_id = a.id AND ac.contact_id::text = ($1)::text
            )
          )
        LIMIT 1`,
      [id, ApplicationStage.FRAUD],
    );
    // BF_SERVER_FRAUD_GUARD_ROWS_v53 - as above: prove it with a value.
    return Boolean((r.rows ?? [])[0]?.fraud_application_id);
  } catch {
    return false;
  }
}

export class FraudLockedError extends Error {
  readonly status = 423;
  readonly code = "application_locked";
  constructor(message = FRAUD_LOCK_MESSAGE) {
    super(message);
    this.name = "FraudLockedError";
  }
}

export async function assertApplicationNotFraud(
  pool: MinimalPool,
  applicationId: string | null | undefined,
): Promise<void> {
  if (await isApplicationFraud(pool, applicationId)) {
    throw new FraudLockedError();
  }
}
