import { Router } from "express";
import { generateVoiceToken } from "../telephony/services/voiceToken";

const router = Router();

router.get("/voice/token", (req, res) => {
  const identity = req.query.identity as string;

  if (!identity) {
    return res.status(400).json({ error: "identity required" });
  }

  const token = generateVoiceToken(identity);

  return res.json({ token });
});

export default router;
