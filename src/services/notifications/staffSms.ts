// BF_SERVER_BLOCK_v115_STAFF_SMS_v1
// Fans out SMS to either currently-available staff (joined from
// staff_presence) or the after-hours fallback list (env-driven CSV
// of E.164 numbers). All sends route through the BF caller ID
// (+18254511768) already configured on App Service.
import { pool } from "../../db.js";
import { logError, logInfo } from "../../observability/logger.js";

type Recipients = "available" | "fallback";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

function fallbackNumbers(): string[] {
  const raw = (process.env.MAYA_FALLBACK_SMS_NUMBERS ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((n) => n.trim())
    .filter((n) => /^\+[1-9]\d{6,14}$/.test(n));
}

async function getAvailableStaffPhones(): Promise<string[]> {
  // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — also require a recent
  // heartbeat (≤2 min), since status='available' can be stale if a tab
  // crashed without firing the offline beacon.
  const { rows } = await pool.query<{ phone: string }>(
    `SELECT u.phone
       FROM staff_presence sp
       JOIN users u ON u.id = sp.user_id
      WHERE sp.status = 'available'
        AND sp.last_heartbeat > NOW() - INTERVAL '2 minutes'
        AND u.phone IS NOT NULL
        AND u.phone <> ''`,
  );
  return rows.map((r) => r.phone);
}

async function twilioSend(to: string, body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_CALLER_ID || process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error("twilio_not_configured");
  }
  const url = `${TWILIO_BASE}/Accounts/${sid}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`twilio_send_failed_${res.status}:${text.slice(0, 200)}`);
  }
}

export type StaffSmsResult = {
  recipients: Recipients;
  attempted: string[];
  delivered: string[];
  failed: Array<{ to: string; error: string }>;
};

export async function sendStaffNotification(args: {
  recipients: Recipients;
  body: string;
}): Promise<StaffSmsResult> {
  // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — when recipients='available'
  // returns empty (nobody actually online with a recent heartbeat), fall
  // back to the env-driven fallback list so client messages never go
  // unnoticed. Resolves Todd's spec #5 (staff-SMS when offline).
  let targets: string[];
  let effectiveRecipients: Recipients = args.recipients;
  if (args.recipients === "available") {
    targets = await getAvailableStaffPhones();
    if (targets.length === 0) {
      const fb = fallbackNumbers();
      if (fb.length > 0) {
        targets = fb;
        effectiveRecipients = "fallback";
      }
    }
  } else {
    targets = fallbackNumbers();
  }

  const delivered: string[] = [];
  const failed: Array<{ to: string; error: string }> = [];

  for (const to of targets) {
    try {
      await twilioSend(to, args.body);
      delivered.push(to);
    } catch (e: any) {
      failed.push({ to, error: e?.message ?? "unknown" });
    }
  }

  logInfo("maya_handoff_sms_fanout", {
    recipients: effectiveRecipients,
    requestedRecipients: args.recipients,
    attempted: targets.length,
    delivered: delivered.length,
    failed: failed.length,
  });

  if (failed.length > 0) {
    logError("maya_handoff_sms_partial_failure", { failed });
  }

  return {
    recipients: effectiveRecipients,
    attempted: targets,
    delivered,
    failed,
  };
}
