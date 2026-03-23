import { Router } from "express";
import twilio from "twilio";
import { config } from "../config";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      dial: (attrs: {
        timeout: number;
        callerId: string | undefined;
        statusCallback: string;
        statusCallbackEvent: string[];
        statusCallbackMethod: "POST";
      }) => { client: (identity: string) => void };
      toString: () => string;
    };
  };
};

const twilioRuntime = twilio as unknown as TwilioRuntime;

router.post("/voice/incoming", (_req: any, res: any) => {
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const dial = twiml.dial({
    timeout: 20,
    callerId: config.twilio.phoneNumber,
    statusCallback: "/api/voice/status",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  dial.client("staff_portal");
  dial.client("staff_mobile");

  res.type("text/xml");
  res.send(twiml.toString());
});

export default router;
