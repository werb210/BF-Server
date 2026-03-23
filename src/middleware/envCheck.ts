import type { NextFunction, Request, Response } from "express";
import { logger } from "../server/utils/logger";
import { config } from "../config";

export default function envCheck(_req: Request, res: Response, next: NextFunction): void {
  if (config.env === "test") {
    next();
    return;
  }

  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    logger.error("env_missing", { missing });
    res.status(500).json({ success: false, error: `env_missing: ${missing.join(",")}` });
    return;
  }

  next();
}
