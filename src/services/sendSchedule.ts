// BF_SERVER_SEND_LATER_v35
// Resolve caller-selected send times while preserving the existing cancellation hold.

/** Minimum lead time. A send scheduled sooner still gets its cancel window. */
export const MIN_LEAD_MINUTES = 2;
/** Refuse anything further out than this - past it, a date is a typo. */
export const MAX_LEAD_DAYS = 90;

export class SendScheduleError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SendScheduleError";
  }
}

export type ResolvedSchedule = { at: Date; scheduled: boolean; coerced: boolean };

/**
 * Resolve an optional ISO 8601 send time into the timestamp stored on the job.
 * Invalid values are rejected rather than silently becoming immediate sends.
 */
export function resolveScheduledAt(
  input: unknown,
  holdMinutes: number,
  now: Date = new Date(),
): ResolvedSchedule {
  const floor = new Date(now.getTime() + Math.max(MIN_LEAD_MINUTES, holdMinutes) * 60_000);
  const raw = typeof input === "string" ? input.trim() : "";

  if (!raw) return { at: floor, scheduled: false, coerced: false };

  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new SendScheduleError("invalid_send_at", "sendAt is not a valid date.");
  }

  const ceiling = new Date(now.getTime() + MAX_LEAD_DAYS * 24 * 60 * 60_000);
  if (at.getTime() > ceiling.getTime()) {
    throw new SendScheduleError(
      "send_at_too_far",
      `sendAt cannot be more than ${MAX_LEAD_DAYS} days away.`,
    );
  }

  if (at.getTime() < floor.getTime()) {
    return { at: floor, scheduled: true, coerced: true };
  }

  return { at, scheduled: true, coerced: false };
}
