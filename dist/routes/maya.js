import express from "express";
import { validate } from "../middleware/validate.js";
import { ok } from "../lib/apiResponse.js";
import { MayaMessageSchema } from "../schemas/index.js";
import { wrap } from "../lib/routeWrap.js";
const router = express.Router();
function requireMayaMessage(req, res, next) {
    if (!req.body?.message) {
        return next(new Error("INVALID_MESSAGE"));
    }
    return next();
}
async function handleMayaMessage(req, res) {
    const { message } = req.validated;
    return ok({
        reply: `Maya received: ${message}`,
    });
}
router.post("/chat", requireMayaMessage, validate(MayaMessageSchema), wrap(handleMayaMessage));
router.post("/message", requireMayaMessage, validate(MayaMessageSchema), wrap(handleMayaMessage));
export default router;
