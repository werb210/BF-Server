import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { eventBus } from "../events/eventBus.js";
import { optionalString, requireString } from "../system/validate.js";

const router = Router();

// GET /api/messages?contactId=X&applicationId=Y
router.get(
  "/",
  safeHandler(async (req: any, res: any) => {
    const contactId = typeof req.query.contactId === "string" ? req.query.contactId.trim() : null;
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;

    if (!contactId && !applicationId) {
      throw new AppError("validation_error", "contactId or applicationId is required.", 400);
    }

    const condition = contactId
      ? "contact_id = $1"
      : `contact_id = (
           SELECT id FROM crm_contacts WHERE application_id = $1 LIMIT 1
         )`;

    const rows = await pool.query(
      `SELECT id, contact_id, application_id, direction, body, created_at, staff_name
       FROM communications_messages
       WHERE ${condition}
       ORDER BY created_at ASC
       LIMIT 200`,
      [contactId ?? applicationId]
    );

    res.status(200).json({
      status: "ok",
      data: rows.rows.map((r: any) => ({
        id: r.id,
        contactId: r.contact_id,
        applicationId: r.application_id,
        role: r.direction === "outbound" ? "staff" : "client",
        content: r.body,
        staffName: r.staff_name ?? null,
        createdAt: r.created_at,
      })),
    });
  })
);

// POST /api/messages
router.post(
  "/",
  safeHandler(async (req: any, res: any, _next: any) => {
    let applicationId = "";
    let body = "";
    try {
      applicationId = requireString(req.body?.applicationId, "APPLICATION_ID");
      body = requireString(req.body?.body, "BODY");
    } catch (_err) {
      throw new AppError("validation_error", "applicationId and body are required.", 400);
    }

    const id = randomUUID();
    const contactId = typeof req.body?.contactId === "string" ? req.body.contactId.trim() : null;
    const direction = optionalString(req.body?.direction) ?? "inbound";
    const staffName = typeof req.body?.staffName === "string" ? req.body.staffName.trim() : null;

    await runQuery(
      `INSERT INTO communications_messages (id, type, direction, status, contact_id, application_id, body, staff_name, created_at)
       VALUES ($1, 'message', $2, 'received', $3, $4, $5, $6, now())`,
      [id, direction, contactId, applicationId, body, staffName]
    );

    eventBus.emit("message_received", { messageId: id, applicationId });

    res.status(201).json({ status: "ok", data: { message: { id, applicationId, body } } });
  })
);

export default router;
