import { Router } from "express";
import twilio from "twilio";

const router = Router();

function resolveVoiceIdentity(query: Record<string, unknown>): string {
  const requestedIdentity = typeof query.identity === "string" ? query.identity.trim() : "";

  if (requestedIdentity === "staff_portal" || requestedIdentity === "staff_mobile") {
    return requestedIdentity;
  }

  if (requestedIdentity.startsWith("client_")) {
    return requestedIdentity;
  }

  const clientId = typeof query.clientId === "string" ? query.clientId.trim() : "";

  if (clientId.length > 0) {
    return `client_${clientId}`;
  }

  return "staff_portal";
}

router.get("/voice/token", (req, res) => {
  const identity = resolveVoiceIdentity(req.query as Record<string, unknown>);

  const AccessToken = (twilio as any).jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const apiKey = process.env.TWILIO_API_KEY!;
  const apiSecret = process.env.TWILIO_API_SECRET!;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID!;

  const token = new AccessToken(accountSid, apiKey, apiSecret, { identity });

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  res.json({
    identity,
    token: token.toJwt(),
  });
});

export default router;
