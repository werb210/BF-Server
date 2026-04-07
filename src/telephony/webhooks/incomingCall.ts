import type { Request, Response } from "express";
import { ok } from "../../lib/response";

const twilioModule = require("twilio") ;

export function incomingCallHandler(req: Request, res: Response): void {
  const VoiceResponse = twilioModule.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  res.json(ok(response.toString(), req.rid));
  return;
}
