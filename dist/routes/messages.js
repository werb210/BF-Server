"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const eventBus_1 = require("../events/eventBus");
const router = (0, express_1.Router)();
router.post("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!applicationId || !body) {
        throw new errors_1.AppError("validation_error", "applicationId and body are required.", 400);
    }
    const id = (0, crypto_1.randomUUID)();
    await db_1.pool.runQuery(`insert into communications_messages (id, type, direction, status, contact_id, body, created_at)
       values ($1, 'message', coalesce($2, 'inbound'), 'received', null, $3, now())`, [id, typeof req.body?.direction === "string" ? req.body.direction : "inbound", body]);
    eventBus_1.eventBus.emit("message_received", { messageId: id, applicationId });
    res.status(201).json({ message: { id, applicationId, body } });
}));
exports.default = router;
