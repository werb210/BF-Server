import { Router } from "express";
import { createVoiceToken } from "../services/telephony/tokenService";

const router = Router();

router.post("/token", (req, res) => {

  const { identity } = req.body;

  const token = createVoiceToken(identity);

  res.json({ token });

});

router.post("/presence", (req, res) => {

  res.json({ ok: true });

});

router.get("/history", (req, res) => {

  res.json({ calls: [] });

});

export default router;
