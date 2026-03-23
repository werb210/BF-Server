import { Router } from "express";
import AccessToken from "twilio/lib/jwt/AccessToken";
import { VoiceGrant } from "twilio/lib/jwt/AccessToken";
import { requireAuth } from "../middleware/auth";
import { ROLES, type Role } from "../auth/roles";
import { config } from "../config";

const router = Router();

const STAFF_VOICE_ROLES: ReadonlySet<Role> = new Set([ROLES.ADMIN, ROLES.STAFF, ROLES.OPS]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidClientId(clientId: string): boolean {
  return uuidPattern.test(clientId);
}

function resolveVoiceIdentity(params: {
  query: Record<string, unknown>;
  userId: string;
  role: Role;
}): string | null {
  const { query, userId, role } = params;
  const requestedIdentity = typeof query.identity === "string" ? query.identity.trim() : "";
  const clientIdFromQuery = typeof query.clientId === "string" ? query.clientId.trim() : "";
  const isStaffRole = STAFF_VOICE_ROLES.has(role);

  if (requestedIdentity === "staff_portal" || requestedIdentity === "staff_mobile") {
    return isStaffRole ? requestedIdentity : null;
  }

  if (requestedIdentity.startsWith("client_")) {
    const clientId = requestedIdentity.slice("client_".length);
    if (!isValidClientId(clientId)) {
      return null;
    }
    if (isStaffRole || userId === clientId) {
      return requestedIdentity;
    }
    return null;
  }

  if (clientIdFromQuery.length > 0) {
    if (!isValidClientId(clientIdFromQuery)) {
      return null;
    }
    if (isStaffRole || userId === clientIdFromQuery) {
      return `client_${clientIdFromQuery}`;
    }
    return null;
  }

  if (requestedIdentity.length > 0) {
    return null;
  }

  return isStaffRole ? "staff_portal" : null;
}

router.get("/voice/token", requireAuth, (req: any, res: any) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ ok: false, error: "missing_token" });
    return;
  }

  const identity = resolveVoiceIdentity({
    query: req.query as Record<string, unknown>,
    userId: user.userId,
    role: user.role,
  });

  if (!identity) {
    res.status(400).json({ code: "invalid_identity", message: "Invalid voice identity." });
    return;
  }

  const accountSid = config.twilio.accountSid!;
  const apiKey = config.twilio.apiKey!;
  const apiSecret = config.twilio.apiSecret!;
  const twimlAppSid = config.twilio.voiceAppSid!;

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
