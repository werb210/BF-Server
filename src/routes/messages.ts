import { randomUUID } from "crypto";
import { Router } from "express";
import { pool, runQuery } from "../db";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";
import { eventBus } from "../events/eventBus";
import { optionalString, requireString } from "../system/validate";

const router = Router();

router.post(
  "/",
  safeHandler(async (req: any, res: any, next: any) => {
    let applicationId = "";
    let body = "";
    try {
      applicationId = requireString(req.body?.applicationId, "APPLICATION_ID");
      body = requireString(req.body?.body, "BODY");
    } catch (_err) {
      throw new AppError("validation_error", "applicationId and body are required.", 400);
    }

    const id = randomUUID();
    await runQuery(
      `insert into communications_messages (id, type, direction, status, contact_id, body, created_at)
       values ($1, 'message', coalesce($2, 'inbound'), 'received', null, $3, now())`,
      [id, optionalString(req.body?.direction) ?? "inbound", body]
    );

    eventBus.emit("message_received", { messageId: id, applicationId });

    res.status(201).json({ message: { id, applicationId, body } });
  })
);

export default router;
