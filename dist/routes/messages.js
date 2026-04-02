"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const eventBus_1 = require("../events/eventBus");
const validate_1 = require("../system/validate");
const router = (0, express_1.Router)();
router.post("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    let applicationId = "";
    let body = "";
    try {
        applicationId = (0, validate_1.requireString)(req.body?.applicationId, "APPLICATION_ID");
        body = (0, validate_1.requireString)(req.body?.body, "BODY");
    }
    catch (_err) {
        throw new errors_1.AppError("validation_error", "applicationId and body are required.", 400);
    }
    const id = (0, crypto_1.randomUUID)();
    await (0, db_1.runQuery)(`insert into communications_messages (id, type, direction, status, contact_id, body, created_at)
       values ($1, 'message', coalesce($2, 'inbound'), 'received', null, $3, now())`, [id, (0, validate_1.optionalString)(req.body?.direction) ?? "inbound", body]);
    eventBus_1.eventBus.emit("message_received", { messageId: id, applicationId });
    res.status(201).json({ message: { id, applicationId, body } });
}));
exports.default = router;
