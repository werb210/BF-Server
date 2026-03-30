"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const node_crypto_1 = require("node:crypto");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.post("/", async (req, res, next) => {
    const { name, email, conversation } = req.body;
    const sessionId = (0, node_crypto_1.randomUUID)();
    await (0, db_1.dbQuery)(`insert into chat_sessions (id, user_type, status)
     values ($1, 'guest', 'escalated')`, [sessionId]);
    await (0, db_1.dbQuery)(`insert into chat_messages (id, session_id, role, message, metadata)
     values ($1, $2, 'user', $3, $4::jsonb)`, [
        (0, node_crypto_1.randomUUID)(),
        sessionId,
        "Chat escalation request",
        JSON.stringify({ name: name ?? null, email: email ?? null, conversation: conversation ?? null }),
    ]);
    return res["json"]({ success: true, sessionId });
});
exports.default = router;
