// BF_SERVER_v823_LIVE_ACTIVITY
// The client app keeps the application's stage on the phone's lock screen:
//   iPhone  - a Live Activity ("In Review · step 2 of 7 · Upload 1 document"), updated by APNs liveactivity pushes
//   Android - a quiet status notification, updated by an FCM data message (type "application_status")
// The app registers with POST /api/client/application-status/watch. A worker checks every two minutes and pushes only
// when the stage changed, so this does not depend on the twenty-odd places that move an application's stage. At a
// final stage (funded / declined) the iPhone activity ends and the Android notification becomes dismissible.
// iOS ends a Live Activity after 8 hours, and an application takes days, so the phone also hands over a
// push-to-start token (iOS 17.2+): a stage change after the activity has gone starts a new one.
import { pool } from "../../db.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const STATUS_STEPS = [
  { key: "received", label: "Received" },
  { key: "in_review", label: "In Review" },
  { key: "documents_required", label: "Documents Required" },
  { key: "additional_steps_required", label: "Additional Steps" },
  { key: "off_to_lender", label: "Off to Lender" },
  { key: "offer", label: "Offer" },
  { key: "funded", label: "Funded" },
] as const;

const FUNDED = /^(accepted|funded)$/i;
const DECLINED = /^(declined|rejected|closed|withdrawn|lost|cancelled|canceled)$/i;

export type StatusContent = { stage: string; step: number; totalSteps: number; action: string; final: boolean };

/** pipeline_state -> what the lock screen shows. Unknown stages keep their own words. */
export function statusContent(pipelineState: unknown): StatusContent {
  const raw = String(pipelineState ?? "").trim();
  const totalSteps = STATUS_STEPS.length;
  if (FUNDED.test(raw)) {
    return { stage: "Funded", step: totalSteps, totalSteps, action: "Your funding is complete.", final: true };
  }
  if (DECLINED.test(raw)) {
    return { stage: "Closed", step: totalSteps, totalSteps, action: "Open the app for details.", final: true };
  }
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  const index = STATUS_STEPS.findIndex((step) => step.key === key);
  const stage = index >= 0 ? STATUS_STEPS[index]!.label : (raw.replace(/_/g, " ") || "Received");
  const action = key === "documents_required" ? "Upload your documents"
    : key === "additional_steps_required" ? "A few more items are needed"
    : key === "offer" ? "Review your offer"
    : key === "off_to_lender" ? "With lenders now"
    : "We're working on it";
  return { stage, step: index >= 0 ? index + 1 : 1, totalSteps, action, final: false };
}

export function statusSignature(content: StatusContent): string {
  return `${content.stage}|${content.step}|${content.action}`;
}

export const LIVE_ACTIVITY_MAX_MS = 8 * 3600 * 1000;

/** Push-to-start: a new Live Activity for a stage change after the last one ended (iOS 17.2+). */
export function liveActivityStartPayload(applicationId: string, business: string, content: StatusContent, nowSeconds: number): Record<string, unknown> {
  return {
    aps: {
      timestamp: nowSeconds,
      event: "start",
      "content-state": { stage: content.stage, step: content.step, totalSteps: content.totalSteps, action: content.action },
      "attributes-type": "ApplicationStatusAttributes",
      attributes: { applicationId, business },
      alert: { title: "Boreal Financial", body: `${content.stage} · ${content.action}` },
    },
  };
}

/** The APNs Live Activity payload (push type liveactivity). */
export function liveActivityPayload(content: StatusContent, nowSeconds: number): Record<string, unknown> {
  const contentState = { stage: content.stage, step: content.step, totalSteps: content.totalSteps, action: content.action };
  if (content.final) {
    // Leave the final state on the lock screen for four hours, then iOS removes it.
    return { aps: { timestamp: nowSeconds, event: "end", "content-state": contentState, "dismissal-date": nowSeconds + 4 * 3600 } };
  }
  return {
    aps: {
      timestamp: nowSeconds,
      event: "update",
      "content-state": contentState,
      // A stage change lights the screen once, like a notification.
      alert: { title: "Boreal Financial", body: `${content.stage} · ${content.action}` },
    },
  };
}

/** The Android FCM data message (BorealMessagingService draws the status notification). */
export function androidStatusData(applicationId: string, content: StatusContent): Record<string, string> {
  return {
    type: "application_status",
    applicationId,
    stage: content.stage,
    step: String(content.step),
    totalSteps: String(content.totalSteps),
    action: content.action,
    final: content.final ? "1" : "0",
  };
}

export type WatchInput = {
  applicationId: string;
  platform: "ios" | "android";
  userId: string | null;
  activityToken?: string | null;
  startToken?: string | null;
  environment?: "production" | "sandbox";
};

const TOKEN = /^[0-9a-f]{32,256}$/i;

export function validWatch(input: Partial<WatchInput>): input is WatchInput {
  if (typeof input.applicationId !== "string" || !input.applicationId.trim() || input.applicationId.length > 64) return false;
  if (input.platform !== "ios" && input.platform !== "android") return false;
  const hex = (value: unknown) => typeof value === "string" && TOKEN.test(value);
  if (input.activityToken != null && !hex(input.activityToken)) return false;
  if (input.startToken != null && !hex(input.startToken)) return false;
  if (input.platform === "ios" && !hex(input.activityToken) && !hex(input.startToken)) return false;
  return true;
}

export async function upsertWatch(input: WatchInput, current: StatusContent, db: Q = pool): Promise<void> {
  await db.query(
    `INSERT INTO client_status_watch (application_id, platform, user_id, activity_token, activity_started_at, start_token,
                                      environment, last_signature, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, $5, $6, $7, now())
     ON CONFLICT (application_id, platform) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           activity_started_at = CASE
             WHEN EXCLUDED.activity_token IS NULL THEN client_status_watch.activity_started_at
             WHEN EXCLUDED.activity_token IS DISTINCT FROM client_status_watch.activity_token THEN now()
             ELSE client_status_watch.activity_started_at END,
           activity_token = COALESCE(EXCLUDED.activity_token, client_status_watch.activity_token),
           start_token = COALESCE(EXCLUDED.start_token, client_status_watch.start_token),
           environment = EXCLUDED.environment,
           last_signature = EXCLUDED.last_signature, ended_at = NULL, updated_at = now()`,
    [input.applicationId, input.platform, input.userId, input.activityToken ?? null, input.startToken ?? null,
      input.environment ?? "production", statusSignature(current)],
  );
}

export async function endWatch(applicationId: string, platform: "ios" | "android", db: Q = pool): Promise<void> {
  await db.query(
    `UPDATE client_status_watch SET ended_at = now(), updated_at = now() WHERE application_id = $1 AND platform = $2`,
    [applicationId, platform],
  );
}

type Senders = {
  sendLiveActivity: (token: string, environment: "production" | "sandbox", payload: Record<string, unknown>) => Promise<void>;
  sendAndroid: (userId: string, data: Record<string, string>, title: string, body: string) => Promise<number>;
};

async function defaultSenders(): Promise<Senders> {
  const { clientApnsProvider } = await import("../clientPushService.js");
  const { WatchApnsError } = await import("../../watch/apnsProvider.js");
  const { getFcmProvider } = await import("../fcmProvider.js");
  return {
    async sendLiveActivity(token, environment, payload) {
      const provider = clientApnsProvider();
      if (!provider) throw new Error("client_apns_not_configured");
      try {
        await provider.send({ token, environment }, payload, { pushType: "liveactivity", priority: "10" });
      } catch (error) {
        // TestFlight / App Store builds hold production tokens, Xcode builds sandbox ones.
        if (!(error instanceof WatchApnsError && error.reason === "BadDeviceToken")) throw error;
        await provider.send({ token, environment: environment === "production" ? "sandbox" : "production" }, payload,
          { pushType: "liveactivity", priority: "10" });
      }
    },
    async sendAndroid(userId, data, title, body) {
      const fcm = getFcmProvider();
      if (!fcm) return 0;
      const { rows } = await pool.query<{ token: string }>(
        `SELECT token FROM client_push_tokens WHERE user_id = $1 AND lower(coalesce(platform, '')) = 'android'
          ORDER BY updated_at DESC LIMIT 5`,
        [userId],
      );
      let sent = 0;
      for (const row of rows) {
        try { await fcm.send({ token: row.token }, { title, body, data }); sent += 1; }
        catch (error) { logWarnSwallowed(error, "applicationStatusLive.sendAndroid"); }
      }
      return sent;
    },
  };
}

/** One pass: every open watch whose application changed stage gets a push. Returns how many were sent. */
export async function runStatusSweep(deps: { db?: Q; senders?: Senders; now?: () => number } = {}): Promise<number> {
  const db = deps.db ?? pool;
  const now = deps.now ?? Date.now;
  const { rows } = await db.query(
    `SELECT w.id, w.application_id, w.platform, w.user_id, w.activity_token, w.activity_started_at, w.start_token,
            w.environment, w.last_signature, a.pipeline_state,
            coalesce(a.metadata->>'businessName', '') AS business
       FROM client_status_watch w
       JOIN applications a ON a.id::text = w.application_id
      WHERE w.ended_at IS NULL AND w.updated_at > now() - interval '60 days'
      ORDER BY w.updated_at DESC
      LIMIT 500`,
  );
  if (rows.length === 0) return 0;
  const senders = deps.senders ?? (await defaultSenders());
  let sent = 0;
  for (const row of rows) {
    const content = statusContent(row.pipeline_state);
    const signature = statusSignature(content);
    if (signature === row.last_signature) continue;
    try {
      const environment = row.environment === "sandbox" ? "sandbox" : "production";
      const startedMs = row.activity_started_at ? new Date(row.activity_started_at).getTime() : NaN;
      const activityLive = !!row.activity_token && Number.isFinite(startedMs) && now() - startedMs < LIVE_ACTIVITY_MAX_MS;
      let started = false;
      let delivered = true;
      if (row.platform === "ios" && (activityLive || (row.activity_token && !row.start_token))) {
        await senders.sendLiveActivity(String(row.activity_token), environment, liveActivityPayload(content, Math.floor(now() / 1000)));
      } else if (row.platform === "ios" && row.start_token && !content.final) {
        await senders.sendLiveActivity(String(row.start_token), environment,
          liveActivityStartPayload(String(row.application_id), String(row.business ?? ""), content, Math.floor(now() / 1000)));
        started = true;
      } else if (row.platform === "ios") {
        delivered = false; // nothing on the lock screen to update (e.g. a final stage after the activity ended)
      } else if (row.platform === "android" && row.user_id) {
        await senders.sendAndroid(String(row.user_id), androidStatusData(String(row.application_id), content),
          "Boreal Financial", `${content.stage} · ${content.action}`);
      }
      if (delivered) sent += 1;
      await db.query(
        `UPDATE client_status_watch SET last_signature = $2, last_sent_at = now(), ended_at = $3, updated_at = now(),
                activity_token = CASE WHEN $4 THEN NULL ELSE activity_token END,
                activity_started_at = CASE WHEN $4 THEN NULL ELSE activity_started_at END
          WHERE id = $1`,
        [row.id, signature, content.final ? new Date(now()).toISOString() : null, started],
      );
    } catch (error) {
      // An expired Live Activity token is finished with; anything else is tried again on the next pass.
      const reason = String((error as { reason?: unknown })?.reason ?? "");
      if (["BadDeviceToken", "Unregistered", "ExpiredToken"].includes(reason)) {
        await db.query(`UPDATE client_status_watch SET ended_at = now(), updated_at = now() WHERE id = $1`, [row.id]);
      } else {
        logWarnSwallowed(error, "applicationStatusLive.runStatusSweep");
      }
    }
  }
  return sent;
}
