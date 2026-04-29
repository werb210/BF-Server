import type { Request, RequestHandler } from "express";
import { createHash } from "node:crypto";
import twilio from "twilio";

const { validateRequest } = twilio;
import { logInfo, logWarn } from "../observability/logger.js";
import { config } from "../config/index.js";

// BF_SERVER_TWILIO_WEBHOOK_DIAG_v55c — diagnostic helpers.
// PII safety: we never log the auth token, the full signature, or any body
// values. Fingerprints are sha256-truncated; keys are sorted but values are
// dropped.
function fingerprint(value: string): string {
  if (!value) return "";
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function safeBodyKeys(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  return Object.keys(body as Record<string, unknown>).sort();
}

function resolvePublicWebhookUrl(req: Request): {
  url: string;
  protocol: string;
  host: string;
  forwardedProto: string | null;
  forwardedHost: string | null;
} {
  const forwardedProto = req.get("X-Forwarded-Proto")?.trim() || null;
  const forwardedHost = req.get("X-Forwarded-Host")?.trim() || null;
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get("host") || "";
  if (!host) {
    throw new Error("Missing request host");
  }
  return {
    url: `${protocol}://${host}${req.originalUrl}`,
    protocol,
    host,
    forwardedProto,
    forwardedHost,
  };
}

export const twilioWebhookValidation: RequestHandler = (req: any, res: any, next: any) => {
  const authToken = config.twilio.authToken?.trim();

  if (!authToken) {
    logWarn("twilio_webhook_auth_token_missing", { path: req.originalUrl });
    res.status(500).json({ code: "twilio_misconfigured", message: "Twilio auth token is missing." });
    return;
  }

  const signature = req.get("X-Twilio-Signature")?.trim();
  if (!signature) {
    // BF_SERVER_TWILIO_WEBHOOK_DIAG_v55c — log enough context to distinguish
    // "Twilio didn't send a signature" from "we stripped it at a proxy".
    logWarn("twilio_webhook_signature_missing", {
      path: req.originalUrl,
      method: req.method,
      contentType: req.get("content-type") ?? null,
      hasXTwilioHeader: req.get("X-Twilio-Signature") !== undefined,
      headerKeys: Object.keys(req.headers ?? {}).sort(),
    });
    res.status(403).json({ code: "invalid_signature", message: "Missing Twilio signature." });
    return;
  }

  let resolved;
  try {
    resolved = resolvePublicWebhookUrl(req);
  } catch (err) {
    logWarn("twilio_webhook_url_resolve_failed", {
      path: req.originalUrl,
      err: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ code: "twilio_misconfigured", message: "Cannot resolve webhook URL." });
    return;
  }

  const isValid = validateRequest(
    authToken,
    signature,
    resolved.url,
    (req.body ?? {}) as Record<string, unknown>
  );

  if (!isValid) {
    // BF_SERVER_TWILIO_WEBHOOK_DIAG_v55c — emit FULL diagnostic context so
    // we can identify the cause from logs alone. No secrets logged: token
    // and signature are fingerprinted, body values are dropped.
    logWarn("twilio_webhook_signature_invalid", {
      path: req.originalUrl,
      method: req.method,
      contentType: req.get("content-type") ?? null,
      computedUrl: resolved.url,
      protocol: resolved.protocol,
      host: resolved.host,
      forwardedProto: resolved.forwardedProto,
      forwardedHost: resolved.forwardedHost,
      rawProtocol: req.protocol,
      rawHost: req.get("host") ?? null,
      authTokenLength: authToken.length,
      authTokenFingerprint: fingerprint(authToken),
      signatureLength: signature.length,
      signaturePrefix: signature.slice(0, 8),
      bodyKeys: safeBodyKeys(req.body),
      bodyType: typeof req.body,
      bodyIsArray: Array.isArray(req.body),
    });
    res.status(403).json({ code: "invalid_signature", message: "Invalid Twilio signature." });
    return;
  }

  // BF_SERVER_TWILIO_WEBHOOK_DIAG_v55c — optional success-path logging. Off
  // by default; enable by setting TWILIO_WEBHOOK_DIAG=true to verify a fix
  // is working without re-deploying.
  if (process.env.TWILIO_WEBHOOK_DIAG === "true") {
    logInfo("twilio_webhook_signature_valid", {
      path: req.originalUrl,
      method: req.method,
      computedUrl: resolved.url,
      bodyKeys: safeBodyKeys(req.body),
    });
  }

  next();
};

export const validateTwilioWebhook = twilioWebhookValidation;
