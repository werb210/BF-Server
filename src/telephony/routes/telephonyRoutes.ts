import express from "express";
import { generateVoiceToken } from "../services/tokenService";
import { createConference } from "../services/conferenceService";

const router = express.Router();

router.post("/token", async (req, res) => {
  const { identity } = req.body as { identity?: string };

  const token = generateVoiceToken(identity ?? "");

  res.json({ token });
});

router.post("/outbound-call", async (req, res) => {
  const { to, fromIdentity } = req.body as { to?: string; fromIdentity?: string };

  const conferenceId = `call_${Date.now()}`;

  await createConference(conferenceId);

  res.json({
    conferenceId,
    to,
    fromIdentity,
  });
});

export default router;
