import { Request, Response } from "express";

export function handleIncomingCall(req: Request, res: Response) {

  const VoiceResponse = require("twilio").twiml.VoiceResponse;

  const response = new VoiceResponse();

  const dial = response.dial();

  dial.conference("boreal_main", {
    startConferenceOnEnter: true,
    endConferenceOnExit: false
  });

  res.type("text/xml");

  res.send(response.toString());

}
