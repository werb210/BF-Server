import type { Request, Response } from "express";

const twilioModule = require("twilio") ;

export function incomingCallHandler(_req: Request, res: Response): Response {
  const VoiceResponse = twilioModule.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  res.type("text/xml");
  return res.json(response.toString());
}
