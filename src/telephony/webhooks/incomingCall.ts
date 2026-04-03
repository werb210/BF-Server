import type { Request, Response } from "express";
import { ok } from "../../lib/respond";

const twilioModule = require("twilio") ;

export function incomingCallHandler(_req: Request, res: Response): Response {
  const VoiceResponse = twilioModule.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  return ok(res, response.toString());
}
