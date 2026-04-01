import express from "express";
import { validate } from "../middleware/validate";
import { ok, fail } from "../lib/response";
import { MayaMessageSchema } from "../schemas";

const router = express.Router();

function requireMayaMessage(req: any, res: any, next: any) {
  if (!req.body?.message) {
    return res.status(400).json({
      success: false,
      error: "INVALID_MESSAGE",
    });
  }

  return next();
}

async function handleMayaMessage(req: any, res: any) {
  try {
    const { message } = req.validated as { message: string };
    return ok(res, {
      reply: `Maya received: ${message}`,
    });
  } catch {
    return fail(res, "maya_error", 500);
  }
}

router.post("/chat", requireMayaMessage, validate(MayaMessageSchema), handleMayaMessage);
router.post("/message", requireMayaMessage, validate(MayaMessageSchema), handleMayaMessage);

export default router;
