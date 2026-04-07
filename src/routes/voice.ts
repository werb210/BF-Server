import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse";
import { requireAuth } from "../middleware/requireAuth";
import { validate } from "../middleware/validate";
import { CallStatusSchema } from "../schemas";
import { getEnv } from "../config/env";

const router = express.Router();

function unauthorized(req: Request, res: Response): Response {
  return res.status(401).json({ status: "error", error: "Unauthorized", rid: (req as any).rid });
}

router.get("/token", (req, res) => {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (!auth) {
    return unauthorized(req, res);
  }

  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return unauthorized(req, res);
  }

  const token = match[1];
  if (!token) {
    return unauthorized(req, res);
  }

  const { JWT_SECRET: secret } = getEnv();
  if (!secret) {
    return unauthorized(req, res);
  }

  try {
    jwt.verify(token, secret);
  } catch {
    return unauthorized(req, res);
  }

  return res.status(200).json({ status: "ok", data: { token: "real-token" }, rid: (req as any).rid });
});

router.post("/incoming", (req, res) => {
  const voiceResponse = new VoiceResponse();

  voiceResponse.say("Connecting you to Maya.");
  voiceResponse.dial().client("maya-agent");

  return res.status(200).json({ status: "ok", data: voiceResponse.toString(), rid: (req as any).rid });
});

router.post("/status", requireAuth, validate(CallStatusSchema), (req, res) => {
  return res.status(200).json({ status: "ok", data: { received: true }, rid: (req as any).rid });
});

export default router;
