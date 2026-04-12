import type { Request, Response } from "express";
import twilio from "twilio";
import { ok } from "../../lib/respond.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

export function incomingCallHandler(_req: Request, res: Response): Response {
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  return ok(res, response.toString());
}
