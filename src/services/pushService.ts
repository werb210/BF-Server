import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { config, isTest } from "../config/index.js";

import {
  createPwaNotificationAudit,
  deletePwaSubscriptionByEndpoint,
  listPwaSubscriptionsByUser,
} from "../repositories/pwa.repo.js";
import { logError, logInfo, logWarn } from "../observability/logger.js";
import { trackEvent } from "../observability/appInsights.js";
import { fetchRequestContext } from "../observability/requestContext.js";
import { type Role } from "../auth/roles.js";
import { stripUndefined } from "../utils/clean.js";

const require = createRequire(import.meta.url);

let webpush: any | null | undefined;

function fetchWebPush(): any | null {
  if (webpush !== undefined) {
    return webpush;
  }

  try {
    const loaded = require("web-push");
    webpush = loaded.default ?? loaded;
  } catch {
    webpush = null;
  }

  return webpush;
}

export type PushLevel = "normal" | "high" | "critical";

export type PushAlertPayload = {
  type: "alert";
  title: string;
  body: string;
  level: PushLevel;
  sound: boolean;
  badge?: string;
  data?: string;
};

export type PushSilentPayload = {
  type: "silent";
  data?: string;
  badgeIncrement?: number;
};

export type PushBadgePayload = {
  type: "badge";
  increment: number;
};

export type PushPayload = PushAlertPayload | PushSilentPayload | PushBadgePayload;

export type PushTarget = {
  userId: string;
  role: Role;
};

type PushStatus = {
  configured: boolean;
  enabled: boolean;
  subject?: string;
  error?: string;
};

let pushConfigured = false;
let pushInitAttempted = false;
let cachedStatus: PushStatus = { configured: false, enabled: true };

const DEFAULT_TTL_SECONDS = 3600;
const HIGH_TTL_SECONDS = 24 * 3600;
const CRITICAL_VIBRATE_PATTERN = [200, 100, 200, 100, 200];

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function ensurePayloadSize(payload: unknown): void {
  const maxBytes = config.pwa.pushPayloadMaxBytes;
  const size = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (size > maxBytes) {
    throw new Error(`Push payload exceeds ${maxBytes} bytes.`);
  }
}

function buildWebPushPayload(
  payload: PushPayload,
  target: PushTarget
): Record<string, unknown> {
  if (payload.type === "alert") {
    const isHigh = payload.level === "high" || payload.level === "critical";
    const isCritical = payload.level === "critical";
    const base: Record<string, unknown> = {
      type: payload.type,
      title: payload.title,
      body: payload.body,
      level: payload.level,
      sound: payload.sound,
      badge: payload.badge,
      data: payload.data,
      vibrate: isCritical ? CRITICAL_VIBRATE_PATTERN : [],
      userRole: target.role,
      sentAt: new Date().toISOString(),
    };
    if (isHigh) {
      base.requireInteraction = true;
    }
    if (isCritical) {
      base.requireInteraction = true;
      base.renotify = true;
    }
    return base;
  }

  if (payload.type === "badge") {
    return {
      type: payload.type,
      badgeIncrement: payload.increment,
      silent: true,
      contentAvailable: true,
      userRole: target.role,
      sentAt: new Date().toISOString(),
    };
  }

  return {
    type: payload.type,
    data: payload.data,
    badgeIncrement: payload.badgeIncrement ?? null,
    silent: true,
    contentAvailable: true,
    userRole: target.role,
    sentAt: new Date().toISOString(),
  };
}

function fetchAuditEntry(payload: PushPayload): {
  level: string;
  title: string;
  body: string;
} {
  if (payload.type === "alert") {
    return {
      level: payload.level,
      title: payload.title,
      body: payload.body,
    };
  }
  if (payload.type === "badge") {
    return {
      level: "badge",
      title: "Badge updated",
      body: `Incremented badge by ${payload.increment}.`,
    };
  }
  return {
    level: "silent",
    title: "Silent update",
    body: "Background update delivered.",
  };
}

// BF_SERVER_PUSH_PURGE_403_v1
// 403 was missing here, and that is why the Azure log stream fills with
// push_failed. A 403 from a Web Push endpoint means the VAPID signature is not
// accepted for that subscription - in practice it was created against a
// different key pair than the server signs with now, and can never recover.
// Because 403 was not terminal the row was kept and retried on every
// notification, indefinitely.
function shouldDeleteSubscription(statusCode: number | undefined): boolean {
  return (
    statusCode === 400 ||
    statusCode === 403 ||
    statusCode === 404 ||
    statusCode === 410
  );
}

// BF_SERVER_VAPID_PAIR_GUARD_v112
// A VAPID keypair is EC P-256: the public key is derivable from the private
// key. If VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY come from DIFFERENT keypairs,
// everything downstream looks healthy - the portal fetches the advertised
// public key, mints a subscription against it, stores it - and then every send
// returns 403 forever. That is indistinguishable in the logs from a stale
// subscription, which is exactly how it went unnoticed: the 403 handler above
// deletes the row, the client re-subscribes, and the cycle repeats.
//
// Checked once at boot rather than per send. web-push cannot detect this: it
// signs happily with whatever pair it is given, and only the push service
// rejects it.
function assertVapidPairMatches(publicKey: string, privateKey: string): void {
  try {
    const { createPrivateKey, createPublicKey } = require("node:crypto") as typeof import("node:crypto");
    const b64urlToBuf = (v: string) => Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const d = b64urlToBuf(privateKey);
    if (d.length !== 32) {
      logWarn("push_vapid_private_key_malformed", { bytes: d.length });
      return;
    }
    // Wrap the raw scalar as a PKCS#8 P-256 key so node can derive the point.
    const pkcs8 = Buffer.concat([
      Buffer.from("308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420", "hex"),
      d,
    ]);
    const privateKeyObject = createPrivateKey({
      key: pkcs8,
      format: "der",
      type: "pkcs8",
    });
    const derived = createPublicKey(privateKeyObject)
      .export({ format: "der", type: "spki" })
      .subarray(-65);
    const expected = b64urlToBuf(publicKey);
    if (!derived.equals(expected)) {
      logError("push_vapid_pair_mismatch", {
        detail:
          "VAPID_PUBLIC_KEY does not belong to VAPID_PRIVATE_KEY. Every push will " +
          "return 403 regardless of how many times a device re-subscribes. Generate " +
          "a matched pair (npx web-push generate-vapid-keys) and set BOTH.",
      });
      return;
    }
    logInfo("push_vapid_pair_ok", {});
  } catch (err) {
    // Never let a diagnostic stop push from starting.
    logWarn("push_vapid_pair_check_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isPushEnabled(): boolean {
  const raw = config.pwa.pushEnabled;
  if (raw === undefined) {
    return true;
  }
  return raw.trim().toLowerCase() === "true";
}

export function initializePushService(): PushStatus {
  if (pushInitAttempted) {
    return cachedStatus;
  }
  pushInitAttempted = true;
  if (isTest) {
    cachedStatus = { configured: false, enabled: false, error: "test_env" };
    return cachedStatus;
  }

  const enabled = isPushEnabled();
  if (!enabled) {
    cachedStatus = { configured: false, enabled, error: "push_disabled" };
    logInfo("push_disabled", {});
    return cachedStatus;
  }

  const webpush = fetchWebPush();
  if (!webpush) {
    cachedStatus = { configured: false, enabled, error: "webpush_unavailable" };
    logWarn("push_webpush_unavailable", {});
    return cachedStatus;
  }

  const publicKey = config.security.vapidPublicKey;
  const privateKey = config.security.vapidPrivateKey;
  const subject = config.security.vapidSubject;

  if (!publicKey || !privateKey || !subject) {
    const error = "missing_vapid";
    cachedStatus = stripUndefined({
      configured: false,
      enabled,
      error,
      subject,
    });
    logWarn("push_vapid_missing", { subject: subject ?? null, publicKey: Boolean(publicKey) });
    // BF_SERVER_VAPID_PAIR_GUARD_v112 - only reachable when a key is absent;
    // the pair check itself runs below, once both are present.
    return cachedStatus;
  }

  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    assertVapidPairMatches(publicKey, privateKey);
    pushConfigured = true;
    cachedStatus = {
      configured: true,
      enabled,
      subject,
    };
    logInfo("push_initialized", { subject });
    return cachedStatus;
  } catch (error) {
    const status: PushStatus = stripUndefined({
      configured: false,
      enabled,
      error: error instanceof Error ? error.message : "invalid_vapid",
      subject,
    }) as PushStatus;
    cachedStatus = status;
    logWarn("push_init_failed", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return cachedStatus;
  }
}

export function validatePushEnvironmentAtStartup(): void {
  initializePushService();
}

export function fetchPushStatus(): PushStatus {
  if (!pushInitAttempted) {
    return initializePushService();
  }
  return cachedStatus;
}

export async function sendNotification(
  target: PushTarget,
  payload: PushPayload
): Promise<{ sent: number; failed: number }> {
  initializePushService();
  if (!pushConfigured) {
    logWarn("push_not_configured", { userId: target.userId, role: target.role });
    return { sent: 0, failed: 0 };
  }
  ensurePayloadSize(payload);
  const subscriptions = await listPwaSubscriptionsByUser(target.userId);
  const requestId = fetchRequestContext()?.requestId ?? "unknown";

  // BF_SERVER_PUSH_v59 - bail BEFORE writing the audit row. This used to
  // record deliveredAt for a notification that was then never sent, because
  // the user has no browser registered. An audit trail that reports deliveries
  // which did not happen is worse than no audit trail.
  if (subscriptions.length === 0) {
    // Not a fault: this is the normal state for any user who has not opted in
    // to browser notifications, and notifyAllStaff targets every staff user on
    // every notification. Info, not warn: the platform logger has no debug
    // level, and adding one is more surface than a log tweak deserves.
    logInfo("push_no_subscriptions", {
      userId: target.userId,
      role: target.role,
      requestId,
    });
    return { sent: 0, failed: 0 };
  }

  const messagePayload = buildWebPushPayload(payload, target);
  const payloadHash = hashPayload(messagePayload);
  const auditEntry = fetchAuditEntry(payload);
  await createPwaNotificationAudit({
    userId: target.userId,
    level: auditEntry.level,
    title: auditEntry.title,
    body: auditEntry.body,
    deliveredAt: new Date(),
    payloadHash,
  });

  let sent = 0;
  let failed = 0;
  const isAlert = payload.type === "alert";
  const ttl = isAlert
    ? payload.level === "normal"
      ? DEFAULT_TTL_SECONDS
      : HIGH_TTL_SECONDS
    : DEFAULT_TTL_SECONDS;
  const urgency = isAlert && payload.level !== "normal" ? "high" : "normal";

  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        JSON.stringify(messagePayload),
        {
          TTL: ttl,
          urgency,
        }
      );
      sent += 1;
      trackEvent({
        name: "push_sent",
        properties: {
          userId: target.userId,
          role: target.role,
          requestId,
          endpoint: subscription.endpoint,
          payloadType: payload.type,
        },
      });
      logInfo("push_sent", {
        userId: target.userId,
        role: target.role,
        requestId,
        endpoint: subscription.endpoint,
        payloadType: payload.type,
      });
    } catch (error: any) {
      failed += 1;
      const statusCode = error?.statusCode;
      const dropped = shouldDeleteSubscription(statusCode);
      if (dropped) {
        await deletePwaSubscriptionByEndpoint({
          userId: target.userId,
          endpoint: subscription.endpoint,
        });
      }
      trackEvent({
        name: "push_failed",
        properties: {
          userId: target.userId,
          role: target.role,
          requestId,
          endpoint: subscription.endpoint,
          payloadType: payload.type,
          statusCode: statusCode ?? "unknown",
        },
      });
      logError("push_failed", {
        userId: target.userId,
        role: target.role,
        requestId,
        endpoint: subscription.endpoint,
        payloadType: payload.type,
        statusCode: statusCode ?? "unknown",
        subscriptionDropped: dropped,
        message: error instanceof Error ? error.message : "unknown_error",
      });
    }
  }

  return { sent, failed };
}

export class PushService {
  constructor() {
    initializePushService();
  }

  async sendNotification(target: PushTarget, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    return sendNotification(target, payload);
  }

  generateSubscriptionHash(sub: unknown): string {
    return createHash("sha256").update(JSON.stringify(sub)).digest("hex");
  }
}
