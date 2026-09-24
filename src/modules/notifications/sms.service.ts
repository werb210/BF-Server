import { fetchTwilioClient } from "../../services/twilio.js";
import { config } from "../../config/index.js";
import { withRetry } from "../../lib/retry.js";
import { pushDeadLetter } from "../../lib/deadLetter.js";
import { isPermanentSmsFailure, isUndeliverableNumber } from "../../lib/smsDeliverability.js";

// BF_SERVER_SMS_LOOP_KILL_v121
export class UndeliverableNumberError extends Error {
  readonly code = 21211;
  constructor(to: string) {
    super(`undeliverable_number:${to}`);
    this.name = "UndeliverableNumberError";
  }
}

// BF_SERVER_BLOCK_v464_SMS_DELIVERY - every text asks Twilio for delivery updates
// (POST /api/r/status) and is recorded so the result can be shown to staff.
export type SmsTrack = { kind?: string; applicationId?: string | null };

function statusCallbackUrl(): string {
  return `${(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "")}/api/r/status`;
}

async function recordSmsSent(sid: string | undefined, to: string, track: SmsTrack | undefined, status: string | undefined): Promise<void> {
  if (!sid) return;
  try {
    const { pool } = await import("../../db.js");
    await pool.query(
      `INSERT INTO sms_deliveries (message_sid, to_number, kind, application_id, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_sid) DO NOTHING`,
      [sid, to, track?.kind || "sms", track?.applicationId ?? null, status ?? "queued"],
    );
  } catch (err) {
    console.warn("[sms] delivery record failed", { sid, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function sendSms(
  { to, message, track }: { to: string; message: string; track?: SmsTrack },
  options: { enqueueOnFailure?: boolean } = {},
) {
  const { enqueueOnFailure = true } = options;
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  if (isUndeliverableNumber(to)) {
    console.warn("[sms] undeliverable number, not sent", { to: String(to).slice(0, 6) });
    throw new UndeliverableNumberError(String(to));
  }

  const client = fetchTwilioClient();
  const payload = {
    body: message,
    from: config.twilio.from || config.twilio.number || config.twilio.phone,
    to,
    statusCallback: statusCallbackUrl(),
  };

  try {
    const sent: any = await withRetry(() => client.messages.create(payload), {
      retries: 3,
      shouldRetry: (error) => !isPermanentSmsFailure(error),
    });
    await recordSmsSent(sent?.sid, to, track, sent?.status);
    return sent;
  } catch (error) {
    if (enqueueOnFailure) {
      await pushDeadLetter({ type: "sms", data: payload, error: String(error) });
    }
    throw error;
  }
}
