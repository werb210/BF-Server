import { Router } from "express";
import { config } from "../config/index.js";
import { safeImport } from "../utils/safeImport.js";

const router = Router();

type TwilioRuntime = {
  twiml: {
    VoiceResponse: new () => {
      say: (attrs: { voice: string }, text: string) => void;
      record: (attrs: { maxLength: number; transcribe: boolean; playBeep: boolean }) => void;
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

const twilioRuntime = (await safeImport("twilio")) as TwilioRuntime | null;

router.post("/voice/incoming", async (_req: any, res: any) => {
  if (!twilioRuntime?.twiml?.VoiceResponse) {
    return res.status(503).json({ error: "twilio_unavailable" });
  }
  const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  try {
    const { pool } = await import("../db.js");
    const staffRes = await pool.query<{ twilio_identity: string }>(
      `SELECT twilio_identity FROM staff_presence
        WHERE status = 'available'
          AND last_heartbeat > now() - interval '5 minutes'
          AND twilio_identity IS NOT NULL
        ORDER BY last_heartbeat DESC LIMIT 10`
    );
    const identities = staffRes.rows.map((r) => r.twilio_identity);

    if (identities.length === 0) {
      twiml.say(
        { voice: "Polly.Joanna" },
        "No agents are available. Please leave a message after the tone."
      );
      twiml.record({ maxLength: 120, transcribe: false, playBeep: true });
    } else {
      const dial = twiml.dial({
        timeout: 20,
        callerId: config.twilio.phoneNumber,
        statusCallback: "/api/voice/status",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      });
      for (const identity of identities) {
        dial.client(identity);
      }
    }
  } catch {
    twiml.say(
      { voice: "Polly.Joanna" },
      "We are experiencing technical difficulties. Please try again later."
    );
  }

  return res.type("text/xml").send(twiml.toString());
});

export default router;
