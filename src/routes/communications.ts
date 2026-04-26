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
  const contactId =
    (typeof req.query.contact_id === "string" && req.query.contact_id) ||
    (typeof req.query.contactId === "string" && req.query.contactId) ||
    null;
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  if (!contactId) {
    return res.status(400).json({ error: { code: "validation_error", message: "contact_id is required" } });
  }

  try {
    const result = await pool.query(
      `SELECT id, body, contact_id, direction, from_number, to_number, silo, created_at
       FROM communications_messages
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
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);
  const result = await pool.query(
    `SELECT
      COALESCE(c.id::text, m.from_number) AS thread_key,
      c.id    AS contact_id,
      COALESCE(c.name, m.from_number, m.to_number) AS display_name,
      COALESCE(c.phone, m.from_number, m.to_number) AS phone,
      MAX(m.created_at) AS last_at,
      (SELECT body FROM communications_messages
         WHERE COALESCE(contact_id::text, from_number) =
               COALESCE(c.id::text, m.from_number)
         ORDER BY created_at DESC LIMIT 1) AS last_body,
      SUM(CASE WHEN m.read_at IS NULL AND m.direction='inbound' THEN 1 ELSE 0 END) AS unread_count
    FROM communications_messages m
    LEFT JOIN contacts c ON c.id = m.contact_id
    WHERE m.silo = $1
    GROUP BY thread_key, c.id, display_name, phone
    ORDER BY last_at DESC
    LIMIT 200`,
    [silo]
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ conversations: result.rows });
}));


router.get("/sms/thread", safeHandler(async (req: any, res: any) => {
  const silo = String(req.user?.silo ?? "BF").toUpperCase();
  const rawContact = req.query.contactId ? String(req.query.contactId) : "";
  const rawPhone = req.query.phone ? String(req.query.phone) : "";

  let phone: string | null = null;
  let contactId: string | null = null;

  if (/^new-\d+$/.test(rawContact)) {
    phone = rawContact.slice(4);
  } else if (/^[0-9a-f-]{36}$/i.test(rawContact)) {
    contactId = rawContact;
  } else if (rawPhone) {
    phone = rawPhone;
  } else if (rawContact && /^[+0-9]+$/.test(rawContact)) {
    phone = rawContact;
  }

  if (!contactId && !phone) {
    return res.status(200).json({ messages: [] });
  }

  const params: unknown[] = [silo];
  let where = "silo = $1";
  if (contactId) {
    params.push(contactId);
    where += ` AND contact_id = $${params.length}`;
  } else if (phone) {
    const compact = phone.replace(/[^\d]/g, "");
    const e164 = phone.startsWith("+") ? phone : `+${compact}`;
    params.push(phone, e164, compact);
    where += ` AND contact_id IS NULL AND (
      from_number IN ($${params.length - 2}, $${params.length - 1}, $${params.length}) OR
      to_number   IN ($${params.length - 2}, $${params.length - 1}, $${params.length})
    )`;
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, contact_id, from_number, to_number, direction, body,
              created_at, read_at
       FROM communications_messages
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT 500`,
      params,
    );
    return res.status(200).json({ messages: rows });
  } catch (err) {
    console.error({ event: "sms_thread_error", err: String(err) });
    return res.status(200).json({ messages: [] });
  }
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
        twilio_sid, contact_id, application_id, staff_name, silo, created_at)
     VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, now())`,
    [
      message.status,
      String(body),
      String(to),
      from,
      message.sid,
      contactId ?? null,
      applicationId ?? null,
      staffName,
      ((req as any).user?.silo ?? "BF").toString().toUpperCase(),
    ]
  ).catch(() => {});

  res.json({ id: message.sid, status: message.status, contactId: contactId ?? null });
}));

export default router;
