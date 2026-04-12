import type { Request, Response } from "express";
import { ok } from "../../lib/respond.js";

import twilio from "twilio";

const VoiceResponse = twilio.twiml.VoiceResponse;

export function incomingCallHandler(_req: Request, res: Response): Response {
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  return ok(res, response.toString());
}
