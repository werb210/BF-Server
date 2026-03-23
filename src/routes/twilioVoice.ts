import express, { Router } from "express";
import twilio from "twilio";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      dial: (attrs: {
        answerOnBridge: boolean;
        timeout: number;
      }) => { client: (identity: string) => void };
      toString: () => string;
    };
  };
};

const twilioRuntime = twilio as unknown as TwilioRuntime;

router.post(
  "/twilio/voice",
  express.urlencoded({ extended: false }),
  twilioWebhookValidation,
  (_req: any, res: any) => {
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const dial = response.dial({
    answerOnBridge: true,
    timeout: 20,
  });

  // Ring all staff endpoints simultaneously
  dial.client("staff_portal");
  dial.client("staff_mobile");

    res.type("text/xml");
    res.send(response.toString());
  }
);

export default router;
