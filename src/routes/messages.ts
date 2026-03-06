import { randomUUID } from "crypto";
import { Router } from "express";
import { pool } from "../db";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";
import { eventBus } from "../events/eventBus";

const router = Router();

router.post(
  "/",
  safeHandler(async (req, res) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!applicationId || !body) {
      throw new AppError("validation_error", "applicationId and body are required.", 400);
    }

    const id = randomUUID();
    await pool.query(
      `insert into communications_messages (id, type, direction, status, contact_id, body, created_at)
       values ($1, 'message', coalesce($2, 'inbound'), 'received', null, $3, now())`,
      [id, typeof req.body?.direction === "string" ? req.body.direction : "inbound", body]
    );

    eventBus.emit("message_received", { messageId: id, applicationId });

    res.status(201).json({ message: { id, applicationId, body } });
  })
);

export default router;
