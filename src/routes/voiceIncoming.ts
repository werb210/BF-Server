import { Router } from "express";
import twilio from "twilio";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      dial: (attrs: { timeout: number; callerId: string | undefined }) => { client: (identity: string) => void };
      toString: () => string;
    };
  };
};

const twilioRuntime = twilio as unknown as TwilioRuntime;

router.post("/voice/incoming", (_req, res) => {
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const dial = twiml.dial({
    timeout: 20,
    callerId: process.env.TWILIO_PHONE_NUMBER,
  });

  dial.client("staff_portal");
  dial.client("staff_mobile");

  res.type("text/xml");
  res.send(twiml.toString());
});

export default router;
