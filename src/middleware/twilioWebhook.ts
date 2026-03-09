import { NextFunction, Request, Response } from "express";

import { verifyTwilioSignature } from "../security/twilioVerify";

export function validateTwilioWebhook(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers["x-twilio-signature"];

  if (!signature || Array.isArray(signature)) {
    res.status(401).send("Missing signature");
    return;
  }

  const valid = verifyTwilioSignature(signature, req.originalUrl, req.body as Record<string, string>);

  if (!valid) {
    res.status(403).send("Invalid Twilio signature");
    return;
  }

  next();
}
