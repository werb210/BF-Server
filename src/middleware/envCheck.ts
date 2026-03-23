import type { NextFunction, Request, Response } from "express";
import { logger } from "../server/utils/logger";
import { config } from "../config";

export default function envCheck(_req: Request, res: Response, next: NextFunction): void {
  if (config.env === "test") {
    next();
    return;
  }

  const required = [
    { key: "TWILIO_ACCOUNT_SID", value: config.twilio.accountSid },
    { key: "TWILIO_AUTH_TOKEN", value: config.twilio.authToken },
    { key: "TWILIO_PHONE_NUMBER", value: config.twilio.phoneNumber },
  ] as const;
  const missing = required
    .filter(({ value }) => !value || !value.trim())
    .map(({ key }) => key);

  if (missing.length) {
    logger.error("env_missing", { missing });
    res.status(500).json({ success: false, error: `env_missing: ${missing.join(",")}` });
    return;
  }

  next();
}
