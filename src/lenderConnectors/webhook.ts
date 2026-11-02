// BF_SERVER_v873_LENDER_API - checking that a webhook really came from the lender.
//
// Every connection's webhook address carries a random secret (POST /api/lender-webhooks/<connection id>/<secret>), so
// a guessed or leaked connection id alone is useless. On top of that, per the connection's settings:
//   hmac_sha256_hex / hmac_sha256_base64   HMAC-SHA256 of the raw body (or "<timestamp>.<raw body>" when the lender
//                                          sends a timestamp header, refused when older than 5 minutes) with the
//                                          webhook secret, in the named header, optionally after a prefix ("sha256=")
//   shared_secret_header                   the webhook secret itself in the named header (what a Salesforce Flow
//                                          HTTP callout can send)
//   none                                   the address secret only
// Salesforce Outbound Messages are not signed: the organization id inside must match the lender's (and the address
// secret must match). Every comparison is constant-time.
import { createHmac, timingSafeEqual } from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

export type VerifyInput = {
  scheme: string;
  secret: string;
  rawBody: Buffer | string;
  headers: Record<string, string | string[] | undefined>;
  signatureHeader?: string;
  signaturePrefix?: string;
  timestampHeader?: string;
  nowMs?: number;
};

export type VerifyResult = { ok: true } | { ok: false; reason: "no_secret" | "missing_signature" | "stale" | "mismatch" | "unknown_scheme" };

function header(h: VerifyInput["headers"], name: string): string {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const scheme = input.scheme || "none";
  if (scheme === "none") return { ok: true };
  if (!input.secret) return { ok: false, reason: "no_secret" };
  const sigHeader = input.signatureHeader || (scheme === "shared_secret_header" ? "X-Webhook-Secret" : "X-Signature");
  let got = header(input.headers, sigHeader).trim();
  if (!got) return { ok: false, reason: "missing_signature" };
  if (scheme === "shared_secret_header") return safeEqual(got, input.secret) ? { ok: true } : { ok: false, reason: "mismatch" };
  if (scheme !== "hmac_sha256_hex" && scheme !== "hmac_sha256_base64") return { ok: false, reason: "unknown_scheme" };
  if (input.signaturePrefix && got.startsWith(input.signaturePrefix)) got = got.slice(input.signaturePrefix.length);
  const raw = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : input.rawBody;
  let signed: Buffer = raw;
  if (input.timestampHeader) {
    const ts = header(input.headers, input.timestampHeader).trim();
    const n = Number(ts);
    if (!ts || !Number.isFinite(n)) return { ok: false, reason: "missing_signature" };
    const tsMs = n > 1e12 ? n : n * 1000;
    if (Math.abs((input.nowMs ?? Date.now()) - tsMs) > WEBHOOK_TOLERANCE_SECONDS * 1000) return { ok: false, reason: "stale" };
    signed = Buffer.concat([Buffer.from(`${ts}.`, "utf8"), raw]);
  }
  const mac = createHmac("sha256", input.secret).update(signed).digest(scheme === "hmac_sha256_hex" ? "hex" : "base64");
  const a = scheme === "hmac_sha256_hex" ? got.toLowerCase() : got;
  return safeEqual(a, mac) ? { ok: true } : { ok: false, reason: "mismatch" };
}
