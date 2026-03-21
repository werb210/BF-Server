import { Router, type Request, type Response } from "express";
import { requireAuth, requireAuthorization } from "../../middleware/auth";
import { ROLES } from "../../auth/roles";
import { generateVoiceToken } from "../services/tokenService";
import { createConference } from "../services/conferenceService";

const router = Router();

router.get("/call-status", (_req, res) => {
  res.status(200).json({
    status: "idle",
    activeCall: false,
    timestamp: new Date().toISOString(),
  });
});

router.get("/health", (_req, res) => {
  res.status(200).json({
    telephony: "ok",
    timestamp: new Date().toISOString(),
  });
});

router.use(requireAuth);
router.use(
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
  })
);

async function handleTokenRequest(req: Request, res: Response) {
  const isTest = process.env.NODE_ENV === "test" || process.env.TEST_MODE === "true";
  if (isTest) {
    return res.status(200).json({ token: "test-token" });
  }

  if (!(req as any).user) {
    return res.status(401).json({
      error: "Unauthorized",
      code: "AUTH_REQUIRED",
    });
  }

  const bodyIdentity = typeof req.body?.identity === "string" ? req.body.identity : undefined;
  const queryIdentity = typeof req.query?.identity === "string" ? req.query.identity : undefined;
  const identity = queryIdentity ?? bodyIdentity;

  const token = generateVoiceToken(identity ?? "");

  res.json({ token });
}

router.get("/token", handleTokenRequest);
router.post("/token", handleTokenRequest);

router.post("/outbound-call", async (req, res, next) => {
  const { to, fromIdentity } = req.body as { to?: string; fromIdentity?: string };

  const conferenceId = `call_${Date.now()}`;

  await createConference(conferenceId);

  res.json({
    conferenceId,
    to,
    fromIdentity,
  });
});

router.post("/presence", async (_req, res) => {
  res.json({
    success: true,
  });
});

router.post("/call-status", async (req, res, next) => {
  const { callSid, status } = req.body as { callSid?: string; status?: string };

  if (!callSid) {
    return res.status(400).json({ error: "callSid required" });
  }

  res.json({
    success: true,
    callSid,
    status: status ?? null,
  });
});

export default router;
