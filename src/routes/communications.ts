import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import twilio from "twilio";

const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.COMMUNICATIONS_READ]));

router.get("/", safeHandler((_req: any, res: any) => {
  res.json({ status: "ok" });
}));

// GET /api/communications/messages?contactId=&phone=&applicationId=
router.get("/messages", safeHandler(async (req: any, res: any) => {
  const { contactId, phone, applicationId, page = "1", pageSize = "50" } = req.query;
  const limit = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (contactId) { values.push(contactId); conditions.push(`contact_id = $${values.length}`); }
  if (phone) { values.push(phone); conditions.push(`phone_number = $${values.length}`); }
  if (applicationId) { values.push(applicationId); conditions.push(`application_id = $${values.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  values.push(limit, offset);

  const result = await pool.query(
    `SELECT id, type, direction, status, body, phone_number, from_number, to_number,
            twilio_sid, contact_id, application_id, staff_name, created_at
     FROM communications_messages
     ${where}
     ORDER BY created_at ASC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
  const countRes = await pool.query(
    `SELECT count(*)::int AS total FROM communications_messages ${where}`,
    values.slice(0, -2)
  );
  res.json({ messages: result.rows, total: countRes.rows[0]?.total ?? 0 });
}));

// POST /api/communications/sms — send outbound SMS
router.post("/sms", safeHandler(async (req: any, res: any) => {
  const { contactId, to, body, applicationId } = req.body ?? {};
  if (!body || !to) {
    return res.status(400).json({ error: { message: "to and body are required", code: "validation_error" } });
  }
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) {
    return res.status(503).json({ error: { message: "SMS not configured", code: "service_unavailable" } });
  }
  const client: any = twilio(accountSid, authToken);
  const message = await client.messages.create({ body: String(body), from, to: String(to) });

  // Persist to thread
  const staffName = req.user?.name ?? req.user?.email ?? null;
  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, body, phone_number, from_number, to_number,
        twilio_sid, contact_id, application_id, staff_name, created_at)
     VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, now())`,
    [message.status, String(body), String(to), from, message.sid,
     contactId ?? null, applicationId ?? null, staffName]
  ).catch(() => {});

  res.json({ id: message.sid, status: message.status, contactId: contactId ?? null });
}));

export default router;
