import type { Request, Response } from "express";
import { ok } from "../../lib/respond.js";

import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

export function incomingCallHandler(_req: Request, res: Response): Response {
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  return ok(res, response.toString());
}
