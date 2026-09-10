// BF_SERVER_BLOCK_v334_CLIENT_PUSH_DELIVERY_v1
// Applicant-facing push. Reuses the Watch APNs provider: a .p8 auth key is issued
// per team, not per app, so the same credentials serve the client bundle IDs.
// Best-effort by design — a failed notification must never fail the operation
// that triggered it.
import { logInfo } from "../observability/logger.js";
import { pool } from "../db.js";
import { AppleWatchApnsProvider, WatchApnsError } from "../watch/apnsProvider.js";
// BF_SERVER_FCM_DELIVERY_v1
import { FcmError, getFcmProvider, initializeFcmProvider, isFcmConfigured } from "./fcmProvider.js";

type Silo = "BF" | "BI" | "SLF";

let provider: AppleWatchApnsProvider | null = null;
let configured = false;

const BUNDLE_IDS: Record<Silo, string | undefined> = {
  BF: process.env.CLIENT_APNS_BUNDLE_ID_BF,
  BI: process.env.CLIENT_APNS_BUNDLE_ID_BI,
  SLF: process.env.CLIENT_APNS_BUNDLE_ID_BF,
};

export function initializeClientPushProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") return false;
  initializeFcmProvider(env);
  const team = env.WATCH_APNS_TEAM_ID?.trim();
  const keyId = env.WATCH_APNS_KEY_ID?.trim();
  const key = env.WATCH_APNS_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const bundle = env.CLIENT_APNS_BUNDLE_ID_BF?.trim();
  if (!team || !keyId || !key || !bundle) {
    console.warn(JSON.stringify({ event: "client_apns_not_configured" }));
    return false;
  }
  provider = new AppleWatchApnsProvider({ teamId: team, keyId, privateKey: key, bundleId: bundle });
  configured = true;
  console.log(JSON.stringify({ event: "client_apns_initialized" }));
  return true;
}

export function isClientPushConfigured(): boolean { return configured; }

export function isAnyClientPushConfigured(): boolean { return configured || isFcmConfigured(); }

/** Test seam. */
export function __setClientPushProvider(p: AppleWatchApnsProvider | null): void {
  provider = p; configured = p !== null;
}

async function tokensForUser(userId: string): Promise<{ token: string; platform: string | null }[]> {
  const { rows } = await pool.query<{ token: string; platform: string | null }>(
    `SELECT token, platform FROM client_push_tokens WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 20`,
    [userId],
  ).catch(() => ({ rows: [] as { token: string; platform: string | null }[] }));
  return rows;
}

async function dropToken(token: string): Promise<void> {
  await pool.query(`DELETE FROM client_push_tokens WHERE token = $1`, [token]).catch(() => {});
}

export async function sendClientPush(input: {
  userId: string; title: string; body: string; silo?: Silo; data?: Record<string, unknown>;
}): Promise<{ sent: number; skipped: number; unsupported: number }> {
  if (!provider && !isFcmConfigured()) return { sent: 0, skipped: 0, unsupported: 0 };
  const environment = process.env.CLIENT_APNS_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
  const rows = await tokensForUser(input.userId);
  let sent = 0, skipped = 0, unsupported = 0;
  for (const row of rows) {
    // BF_PUSH_PLATFORM_VISIBILITY_v1
    // Android tokens are FCM, not APNs — never hand them to Apple. Counting
    // them as generic "skipped" hid the fact that every Android install gets
    // nothing: both clients ship real Android builds. Count them separately
    // so the gap is measurable rather than invisible.
    if (row.platform && row.platform.toLowerCase() !== "ios") {
      const fcm = getFcmProvider();
      if (!fcm) {
        unsupported += 1;
        continue;
      }
      try {
        await fcm.send({ token: row.token }, {
          title: input.title,
          body: input.body,
          data: { silo: String(input.silo ?? "BF"), ...(input.data ?? {}) },
        });
        sent += 1;
      } catch (error) {
        if (error instanceof FcmError && error.invalidRegistration) await dropToken(row.token);
        skipped += 1;
      }
      continue;
    }
    if (!provider) { unsupported += 1; continue; }
    try {
      await provider.send({ token: row.token, environment }, {
        aps: { alert: { title: input.title, body: input.body }, sound: "default" },
        ...(input.data ?? {}),
      });
      sent += 1;
    } catch (error) {
      if (error instanceof WatchApnsError && error.invalidRegistration) await dropToken(row.token);
      skipped += 1;
    }
  }
  if (unsupported > 0) {
    logInfo("client_push_unsupported_platform", {
      userId: input.userId,
      unsupported,
      reason: "push_transport_not_configured",
    });
  }
  return { sent, skipped, unsupported };
}
