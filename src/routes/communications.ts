import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import twilio from "twilio";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.COMMUNICATIONS_READ]));

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, { status: "ok" });
}));

router.get("/messages", safeHandler((req: any, res: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  respondOk(res, { messages: [], total: 0 }, { page, pageSize });
}));

router.post("/sms", safeHandler(async (req: any, res: any) => {
  const { contactId, body, to, fromNumber } = req.body ?? {};
  const toNumber = to ?? fromNumber;
  if (!body || !toNumber) {
    return res.status(400).json({ error: { message: "to and body are required", code: "validation_error" } });
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) {
    return res.status(503).json({ error: { message: "SMS not configured", code: "service_unavailable" } });
  }
  const client: any = twilio(accountSid, authToken);
  const message = await client.messages.create({ body: String(body), from, to: String(toNumber) });
  respondOk(res, { id: message.sid, status: message.status, contactId: contactId ?? null });
}));

export default router;
