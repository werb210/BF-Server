"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supportService_1 = require("../services/supportService");
const crmWebhook_1 = require("../services/crmWebhook");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.post("/", async (req, res, next) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: "Missing message" });
    }
    const { rows } = await (0, db_1.dbQuery)("select content from ai_knowledge order by created_at desc");
    const context = rows.map((row) => row.content).join("\n");
    const response = `AI Response based on knowledge: ${message}`;
    return res["json"]({ response, context });
});
router.post("/escalate", async (req, res, next) => {
    const { sessionId, transcript, source } = req.body;
    await (0, supportService_1.createSupportThread)({
        type: "chat_escalation",
        ...(source ? { source } : {}),
        transcript: {
            sessionId: sessionId ?? null,
            transcript: transcript ?? null,
        },
    });
    await (0, crmWebhook_1.pushLeadToCRM)({
        type: "chat_escalation",
        sessionId: sessionId ?? null,
        source: source ?? null,
        transcript: transcript ?? null,
    });
    res["json"]({ escalated: true });
});
exports.default = router;
