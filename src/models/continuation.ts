import crypto from "node:crypto";
import { db } from "../db";

export async function createContinuation(applicationId: string): Promise<string> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

  await db.query(
    `
      insert into continuation_sessions (
        application_id,
        token,
        expires_at,
        application_status,
        current_step,
        last_updated,
        is_completed
      )
      values ($1, $2, $3, 'in_progress', 1, now(), false)
    `,
    [applicationId, token, expiresAt]
  );

  return token;
}

export async function fetchContinuation(token: string): Promise<string | null> {
  const { rows } = await db.query<{ application_id: string }>(
    `
      select application_id
      from continuation_sessions
      where token = $1 and expires_at > now() and is_completed = false
    `,
    [token]
  );

  return rows[0]?.application_id ?? null;
}

export async function updateContinuationStep(token: string, currentStep: number): Promise<void> {
  await db.query(
    `
      update continuation_sessions
      set current_step = $2,
          last_updated = now()
      where token = $1
    `,
    [token, currentStep]
  );
}

export async function completeContinuation(token: string): Promise<void> {
  await db.query(
    `
      update continuation_sessions
      set is_completed = true,
          application_status = 'completed',
          last_updated = now()
      where token = $1
    `,
    [token]
  );
}
