import express from "express";
import { validate } from "../middleware/validate";
import { ok } from "../lib/apiResponse";
import { MayaMessageSchema } from "../schemas";
import { wrap } from "../lib/routeWrap";

const router = express.Router();

function requireMayaMessage(req: any, res: any, next: any) {
  if (!req.body?.message) {
    return next(new Error("INVALID_MESSAGE"));
  }

  return next();
}

async function handleMayaMessage(req: any, res: any) {
    const { message } = req.validated as { message: string };
    return ok({
      reply: `Maya received: ${message}`,
    });
}

router.post("/chat", requireMayaMessage, validate(MayaMessageSchema), wrap(handleMayaMessage));
router.post("/message", requireMayaMessage, validate(MayaMessageSchema), wrap(handleMayaMessage));

export default router;
