import { Router } from "express";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";
import { logWarn } from "../observability/logger";
import { handleVoiceStatusWebhook } from "../modules/voice/voice.service";

const router = Router();


function buildWebhookUrl(req: { protocol: string; get: (name: string) => string | undefined; originalUrl: string }): string {
  const baseUrl = process.env.BASE_URL?.trim();
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice`;
  }
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host ?? "localhost"}${req.originalUrl}`;
}

router.post(
  "/twilio/voice",
  safeHandler(async (req: any, res: any, next: any) => {
    const signature = req.get("x-twilio-signature");
    if (!signature) {
      logWarn("voice_webhook_missing_signature", { path: req.originalUrl });
      throw new AppError("invalid_signature", "Missing Twilio signature.", 403);
    }

    const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
    if (!authToken) {
      throw new AppError("twilio_misconfigured", "Twilio auth token is missing.", 500);
    }
    const url = buildWebhookUrl(req);
    const valid = validateRequest(authToken, signature, url, req.body ?? {});

    if (!valid) {
      logWarn("voice_webhook_signature_invalid", { path: req.originalUrl });
      throw new AppError("invalid_signature", "Invalid Twilio signature.", 403);
    }

    const payload = req.body ?? {};
    const callSid = typeof payload.CallSid === "string" ? payload.CallSid : null;
    if (!callSid) {
      throw new AppError("validation_error", "Missing CallSid.", 400);
    }

    await handleVoiceStatusWebhook({
      callSid,
      callStatus: typeof payload.CallStatus === "string" ? payload.CallStatus : null,
      callDuration: payload.CallDuration ?? null,
      from: typeof payload.From === "string" ? payload.From : null,
      to: typeof payload.To === "string" ? payload.To : null,
      errorCode:
        typeof payload.ErrorCode === "string" || typeof payload.ErrorCode === "number"
          ? String(payload.ErrorCode)
          : null,
      errorMessage: typeof payload.ErrorMessage === "string" ? payload.ErrorMessage : null,
    });

    res.status(200).json({ ok: true });
  })
);

export default router;
