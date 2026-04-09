import fs from "fs";
import path from "path";
import multer from "multer";
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { safeHandler } from "../middleware/safeHandler.js";
import { runQuery } from "../db.js";
import { saveKnowledge as saveKnowledgeDb } from "../services/aiKnowledgeService.js";
import { loadKnowledge, saveKnowledge } from "../modules/ai/knowledge.service.js";
import { AIKnowledgeController, upload as knowledgeUpload } from "../modules/ai/knowledge.controller.js";
import { chatHandler } from "../modules/ai/ai.controller.js";
import { logger } from "../server/utils/logger.js";
import { generateAIResponse } from "../services/ai/aiService.js";
const router = Router();
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const uploadDir = "/tmp/uploads";
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
function cleanupFile(filePath) {
    fs.unlink(filePath, () => undefined);
}
function rejectOversizedPayload(req, res, next) {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: "payload_too_large" });
        return;
    }
    next();
}
const upload = multer({
    storage: multer.diskStorage({
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
const issueUploadDir = path.join(process.cwd(), "uploads", "ai-issues");
function ensureUploadDir() {
    if (!fs.existsSync(issueUploadDir)) {
        fs.mkdirSync(issueUploadDir, { recursive: true });
    }
}
async function tryStoreEscalation(payload) {
    const escalationId = randomUUID();
    try {
        await runQuery(`update chat_sessions
       set status = 'escalated', escalated_to = $2, updated_at = now()
       where id = $1`, [payload.sessionId, payload.escalatedTo ?? null]);
        await runQuery(`insert into ai_escalations (id, session_id, messages, status, created_at)
       values ($1, $2, $3::jsonb, 'open', now())`, [escalationId, payload.sessionId, JSON.stringify(payload.messages ?? [])]);
    }
    catch (error) {
        logger.warn("ai_escalation_store_failed", {
            sessionId: payload.sessionId,
            error: error instanceof Error ? error.message : "unknown_error",
        });
    }
    return escalationId;
}
async function tryStoreReport(payload) {
    const reportId = randomUUID();
    try {
        await runQuery(`insert into issue_reports (id, description, screenshot_base64, user_agent, status, created_at)
       values ($1, $2, $3, $4, 'open', now())`, [
            reportId,
            payload.message,
            payload.screenshot ?? null,
            String(payload.metadata?.userAgent ?? ""),
        ]);
    }
    catch (error) {
        logger.warn("ai_report_store_failed", {
            reportId,
            error: error instanceof Error ? error.message : "unknown_error",
        });
    }
    return reportId;
}
router.post("/chat", safeHandler(async (req, res, next) => {
    if (req.body?.mode !== "core") {
        await chatHandler(req, res);
        return;
    }
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }
    const reply = await generateAIResponse(message);
    res["json"]({ reply });
}));
router.post("/escalate", safeHandler(async (req, res, next) => {
    const sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId.trim().length > 0
        ? req.body.sessionId
        : randomUUID();
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
router.post("/report", safeHandler(async (req, res, next) => {
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
    logger.info("ai_report_received", {
        reportId,
        hasScreenshot: Boolean(screenshot),
        hasContext: Boolean(req.body?.context),
    });
    res.status(202).json({
        accepted: true,
        reportId,
    });
}));
const knowledgeUploadHandler = async (req, res) => {
    await AIKnowledgeController.upload(req, res);
};
router.post("/knowledge/upload", rejectOversizedPayload, knowledgeUpload.single("file"), knowledgeUploadHandler);
router.get("/knowledge", AIKnowledgeController.list);
router.get("/knowledge/db", safeHandler(async (_req, res) => {
    const { rows } = await runQuery(`select id, content, created_at
       from ai_knowledge
       order by created_at desc`);
    res["json"]({ success: true, data: rows });
}));
router.post("/knowledge", safeHandler(async (req, res, next) => {
    const { title, content, sourceType } = req.body;
    if (!content) {
        res.status(400).json({ success: false, error: "Missing content" });
        return;
    }
    const resolvedTitle = title ?? "Knowledge Entry";
    const resolvedSourceType = sourceType ?? "internal";
    await saveKnowledgeDb({
        title: resolvedTitle,
        content,
        sourceType: resolvedSourceType,
    });
    const existing = loadKnowledge();
    existing.push({ title: resolvedTitle, content, createdAt: new Date().toISOString() });
    saveKnowledge(existing);
    res["json"]({ success: true, data: { saved: true } });
}));
router.post("/report-issue", rejectOversizedPayload, upload.single("screenshot"), safeHandler(async (req, res, next) => {
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
        const ext = path.extname(req.file.originalname || "") || ".png";
        const fileName = `${randomUUID()}${ext}`;
        const fullPath = path.join(issueUploadDir, fileName);
        fs.copyFileSync(req.file.path, fullPath);
        cleanupFile(req.file.path);
        screenshotPath = path.relative(process.cwd(), fullPath);
    }
    const id = randomUUID();
    await runQuery(`insert into issue_reports
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
export default router;
