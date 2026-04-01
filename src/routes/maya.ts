import express from "express";
import { validate } from "../middleware/validate";
import { ok, fail } from "../lib/response";
import { MayaMessageSchema } from "../schemas";

const router = express.Router();

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

router.post("/chat", validate(MayaMessageSchema), handleMayaMessage);
router.post("/message", validate(MayaMessageSchema), handleMayaMessage);

export default router;
