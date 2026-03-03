import type { Request, Response } from "express";

const twilioModule = require("twilio") as any;

export function incomingCallHandler(_req: Request, res: Response): void {
  const VoiceResponse = twilioModule.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial();

  dial.client("staff");

  res.type("text/xml");
  res.send(response.toString());
}
