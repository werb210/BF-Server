// BF_SERVER_v875_WEBHOOKS (ported from KS-server #39) - HMAC-SHA256 signatures on webhook deliveries.
//
//   X-Webhook-Timestamp: 1767225600                   (unix seconds when this attempt was sent)
//   X-Webhook-Signature: t=1767225600,v1=<hex>        hex = HMAC_SHA256(secret, `${timestamp}.${raw body}`)
// The receiver recomputes v1 over the raw body and rejects it unless it matches and the timestamp is within 5 minutes
// (a captured request cannot be replayed later). Each attempt is signed afresh, so a retry has a new timestamp.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-Webhook-Signature";
export const TIMESTAMP_HEADER = "X-Webhook-Timestamp";
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A new endpoint secret: whsec_ + 32 random bytes (base64url). Shown to the admin once. */
export function newSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export function computeSignature(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function signatureHeaders(secret: string, body: string, nowMs = Date.now()): Record<string, string> {
  const t = Math.floor(nowMs / 1000);
  return { [TIMESTAMP_HEADER]: String(t), [SIGNATURE_HEADER]: `t=${t},v1=${computeSignature(secret, t, body)}` };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "malformed" | "stale" | "mismatch" };

/** What a receiver does (also used by the "Send test event" check and the tests). */
export function verifySignature(secret: string, header: string, body: string, nowMs = Date.now(), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS): VerifyResult {
  const parts = Object.fromEntries(String(header ?? "").split(",").map((p) => p.trim().split("=", 2)).filter((p) => p.length === 2));
  const t = Number(parts.t);
  const v1 = String(parts.v1 ?? "");
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  if (Math.abs(Math.floor(nowMs / 1000) - t) > toleranceSeconds) return { ok: false, reason: "stale" };
  const want = Buffer.from(computeSignature(secret, t, body), "hex");
  const got = Buffer.from(v1, "hex");
  return want.length === got.length && timingSafeEqual(want, got) ? { ok: true } : { ok: false, reason: "mismatch" };
}
