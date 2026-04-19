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

// GET /api/communications/messages — queries the actual DB
router.get("/messages", safeHandler(async (req: any, res: any) => {
  const contactId = typeof req.query.contact_id === "string" ? req.query.contact_id : null;
  const silo = typeof req.query.silo === "string" ? req.query.silo : "BF";
  if (!contactId) {
    return res.status(400).json({ error: { code: "validation_error", message: "contact_id is required" } });
  }

  try {
    const result = await pool.query(
      `SELECT id, body, contact_id, direction, from_number, to_number, silo, created_at
       FROM messages
       WHERE contact_id = $1
         AND silo = $2
       ORDER BY created_at ASC
      `,
      [contactId, silo]
    );
    res.json({ messages: result.rows, total: result.rows.length });
  } catch {
    res.json({ messages: [], total: 0 });
  }
}));

router.get("/sms", safeHandler(async (req: any, res: any) => {
  const silo = typeof req.query.silo === "string" ? req.query.silo : "BF";
  const result = await pool.query(
    `SELECT
       m.contact_id,
       c.name AS contact_name,
       c.phone AS contact_phone,
       m.body AS latest_message,
       m.created_at AS latest_message_at
     FROM messages m
     LEFT JOIN contacts c ON c.id = m.contact_id
     INNER JOIN (
       SELECT contact_id, max(created_at) AS max_created_at
       FROM messages
       WHERE contact_id IS NOT NULL
         AND silo = $1
       GROUP BY contact_id
     ) latest
       ON latest.contact_id = m.contact_id
      AND latest.max_created_at = m.created_at
     WHERE m.silo = $1
     ORDER BY m.created_at DESC`,
    [silo]
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ conversations: result.rows });
}));

// POST /api/communications/sms — send outbound + persist to DB
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

  // Persist outbound message to DB
  const staffName = (req as any).user?.name ?? (req as any).user?.email ?? null;
  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, body, phone_number, from_number, to_number,
        twilio_sid, contact_id, application_id, staff_name, created_at)
     VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, now())`,
    [
      message.status,
      String(body),
      String(to),
      from,
      message.sid,
      contactId ?? null,
      applicationId ?? null,
      staffName,
    ]
  ).catch(() => {});

  res.json({ id: message.sid, status: message.status, contactId: contactId ?? null });
}));

export default router;
