import type { Request, RequestHandler } from "express";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import { logWarn } from "../observability/logger";
import { config } from "../config";

function resolvePublicWebhookUrl(req: Request): string {
  const forwardedProto = req.get("X-Forwarded-Proto");
  const forwardedHost = req.get("X-Forwarded-Host");
  const protocol = forwardedProto?.trim() || req.protocol;
  const host = forwardedHost?.trim() || req.get("host");
  if (!host) {
    throw new Error("Missing request host");
  }
  return `${protocol}://${host}${req.originalUrl}`;
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
    res.status(403).json({ code: "invalid_signature", message: "Missing Twilio signature." });
    return;
  }

  const isValid = validateRequest(
    authToken,
    signature,
    resolvePublicWebhookUrl(req),
    (req.body ?? {}) as Record<string, unknown>
  );

  if (!isValid) {
    res.status(403).json({ code: "invalid_signature", message: "Invalid Twilio signature." });
    return;
  }

  next();
};

export const validateTwilioWebhook = twilioWebhookValidation;
