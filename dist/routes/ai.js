"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const multer_1 = __importDefault(require("multer"));
const express_1 = require("express");
const crypto_1 = require("crypto");
const safeHandler_1 = require("../middleware/safeHandler");
const db_1 = require("../db");
const aiKnowledgeService_1 = require("../services/aiKnowledgeService");
const knowledge_service_1 = require("../modules/ai/knowledge.service");
const knowledge_controller_1 = require("../modules/ai/knowledge.controller");
const ai_controller_1 = require("../modules/ai/ai.controller");
const logger_1 = require("../server/utils/logger");
const aiService_1 = require("../services/ai/aiService");
const router = (0, express_1.Router)();
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const uploadDir = "/tmp/uploads";
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
function cleanupFile(filePath) {
    fs_1.default.unlink(filePath, () => undefined);
}
function rejectOversizedPayload(req, res, next) {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "payload_too_large" });
        return;
    }
    next();
}
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_, __, cb) => cb(null, uploadDir),
        filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 5 },
    fileFilter: (_req, file, cb) => {
        const allowedMimeTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
        if (!allowedMimeTypes.has(file.mimetype)) {
            cb(new Error("Invalid file type"));
            return;
        }
        cb(null, true);
    },
});
const issueUploadDir = path_1.default.join(process.cwd(), "uploads", "ai-issues");
function ensureUploadDir() {
    if (!fs_1.default.existsSync(issueUploadDir)) {
        fs_1.default.mkdirSync(issueUploadDir, { recursive: true });
    }
}
async function tryStoreEscalation(payload) {
    const escalationId = (0, crypto_1.randomUUID)();
    try {
        await db_1.pool.query(`update chat_sessions
       set status = 'escalated', escalated_to = $2, updated_at = now()
       where id = $1`, [payload.sessionId, payload.escalatedTo ?? null]);
        await db_1.pool.query(`insert into ai_escalations (id, session_id, messages, status, created_at)
       values ($1, $2, $3::jsonb, 'open', now())`, [escalationId, payload.sessionId, JSON.stringify(payload.messages ?? [])]);
    }
    catch (error) {
        logger_1.logger.warn("ai_escalation_store_failed", {
            sessionId: payload.sessionId,
            error: error instanceof Error ? error.message : "unknown_error",
        });
    }
    return escalationId;
}
async function tryStoreReport(payload) {
    const reportId = (0, crypto_1.randomUUID)();
    try {
        await db_1.pool.query(`insert into issue_reports (id, description, screenshot_base64, user_agent, status, created_at)
       values ($1, $2, $3, $4, 'open', now())`, [
            reportId,
            payload.message,
            payload.screenshot ?? null,
            String(payload.metadata?.userAgent ?? ""),
        ]);
    }
    catch (error) {
        logger_1.logger.warn("ai_report_store_failed", {
            reportId,
            error: error instanceof Error ? error.message : "unknown_error",
        });
    }
    return reportId;
}
router.post("/chat", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (req.body?.mode !== "core") {
        await (0, ai_controller_1.chatHandler)(req, res);
        return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }
    const reply = await (0, aiService_1.generateAIResponse)(message);
    res["json"]({ reply });
}));
router.post("/escalate", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId.trim().length > 0
        ? req.body.sessionId
        : (0, crypto_1.randomUUID)();
    const escalationId = await tryStoreEscalation({
        sessionId,
        escalatedTo: typeof req.body?.escalatedTo === "string" ? req.body.escalatedTo : null,
        messages: req.body?.messages,
    });
    res.status(202).json({
        acknowledged: true,
        ok: true,
        escalationId,
        sessionId,
    });
}));
router.post("/report", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const message = typeof req.body?.message === "string" && req.body.message.trim().length > 0
        ? req.body.message
        : "Issue report received";
    const screenshot = typeof req.body?.screenshot === "string" && req.body.screenshot.length > 0
        ? req.body.screenshot
        : null;
    const reportId = await tryStoreReport({
        message,
        screenshot,
        context: req.body?.context,
        metadata: typeof req.body === "object" && req.body !== null
            ? req.body
            : {},
    });
    logger_1.logger.info("ai_report_received", {
        reportId,
        hasScreenshot: Boolean(screenshot),
        hasContext: Boolean(req.body?.context),
    });
    res.status(202).json({
        accepted: true,
        reportId,
    });
}));
router.post("/knowledge/upload", rejectOversizedPayload, knowledge_controller_1.upload.single("file"), knowledge_controller_1.AIKnowledgeController.upload);
router.get("/knowledge", knowledge_controller_1.AIKnowledgeController.list);
router.get("/knowledge/db", (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const { rows } = await db_1.pool.query(`select id, content, created_at
       from ai_knowledge
       order by created_at desc`);
    res["json"]({ success: true, data: rows });
}));
router.post("/knowledge", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const { title, content, sourceType } = req.body;
    if (!content) {
        res.status(400).json({ success: false, error: "Missing content" });
        return;
    }
    const resolvedTitle = title ?? "Knowledge Entry";
    const resolvedSourceType = sourceType ?? "internal";
    await (0, aiKnowledgeService_1.saveKnowledge)({
        title: resolvedTitle,
        content,
        sourceType: resolvedSourceType,
    });
    const existing = (0, knowledge_service_1.loadKnowledge)();
    existing.push({ title: resolvedTitle, content, createdAt: new Date().toISOString() });
    (0, knowledge_service_1.saveKnowledge)(existing);
    res["json"]({ success: true, data: { saved: true } });
}));
router.post("/report-issue", rejectOversizedPayload, upload.single("screenshot"), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const body = req.body;
    if (!body.description || !body.page_url || !body.browser_info) {
        res.status(400).json({
            success: false,
            error: "description, page_url, and browser_info are required",
        });
        return;
    }
    let screenshotPath = null;
    if (req.file) {
        ensureUploadDir();
        const ext = path_1.default.extname(req.file.originalname || "") || ".png";
        const fileName = `${(0, crypto_1.randomUUID)()}${ext}`;
        const fullPath = path_1.default.join(issueUploadDir, fileName);
        fs_1.default.copyFileSync(req.file.path, fullPath);
        cleanupFile(req.file.path);
        screenshotPath = path_1.default.relative(process.cwd(), fullPath);
    }
    const id = (0, crypto_1.randomUUID)();
    await db_1.pool.query(`insert into issue_reports
       (id, session_id, description, page_url, browser_info, screenshot_path, status, created_at)
       values ($1, $2, $3, $4, $5, $6, 'open', now())`, [
        id,
        body.session_id ?? null,
        body.description,
        body.page_url,
        body.browser_info,
        screenshotPath,
    ]);
    res.status(201).json({
        success: true,
        data: { id, screenshotPath },
    });
}));
exports.default = router;
