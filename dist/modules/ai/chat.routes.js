"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("../../config");
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const chat_service_1 = require("./chat.service");
const router = (0, express_1.Router)();
const chatLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many chat requests" },
    skip: () => config_1.config.env === "test",
});
async function createSessionHandler(req, res) {
    const source = typeof req.body?.source === "string" ? req.body.source : "website";
    const session = await (0, chat_service_1.startChatSession)({
        source,
        channel: typeof req.body?.channel === "string" ? req.body.channel : "text",
        lead: req.body?.lead,
    });
    res.status(201).json({ success: true, data: { sessionId: session.id, status: session.status } });
}
router.post("/chat/start", chatLimiter, createSessionHandler);
router.post("/chat/session", chatLimiter, createSessionHandler);
router.post("/chat/message", chatLimiter, async (req, res, next) => {
    const { sessionId, message, source } = req.body;
    if (!sessionId || !message) {
        res.status(400).json({ error: "sessionId and message are required" });
        return;
    }
    const result = await (0, chat_service_1.processChatMessage)({ sessionId, message, source: source ?? "website" });
    res["json"]({ status: result.status, response: result.response });
});
async function transferChatHandler(req, res) {
    const { sessionId } = req.body;
    if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
    }
    try {
        await (0, chat_service_1.requestHumanTakeover)(sessionId);
    }
    catch (error) {
        if (error instanceof Error && error.message === "chat_session_not_found") {
            res.status(404).json({ error: "Session not found" });
            return;
        }
        throw error;
    }
    res["json"]({ status: "human" });
}
router.post("/chat/human", chatLimiter, transferChatHandler);
router.post("/chat/transfer", chatLimiter, transferChatHandler);
router.post("/chat/close", chatLimiter, async (req, res, next) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        res.status(400).json({ error: "sessionId is required" });
        return;
    }
    await (0, chat_service_1.closeChatSession)(sessionId);
    res["json"]({ status: "closed" });
});
router.get("/chat/sessions", async (req, res, next) => {
    const status = req.query.status;
    if (status !== "human") {
        res.status(400).json({ error: "Only status=human is currently supported" });
        return;
    }
    const sessions = await (0, chat_service_1.fetchHumanSessions)();
    res["json"]({ sessions });
});
router.get("/chat/:sessionId/messages", async (req, res, next) => {
    const messages = await (0, chat_service_1.fetchSessionMessages)(req.params.sessionId);
    res["json"]({ messages });
});
exports.default = router;
