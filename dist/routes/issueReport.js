"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const node_crypto_1 = require("node:crypto");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.post("/", async (req, res, next) => {
    const { message, screenshot, pageUrl, browserInfo, sessionId, url } = req.body;
    if (!message && !url) {
        return res.status(400).json({ error: "Message or url required" });
    }
    await (0, db_1.dbQuery)(`insert into issue_reports
      (id, session_id, description, page_url, browser_info, screenshot_path, screenshot_base64, user_agent, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'open')`, [
        (0, node_crypto_1.randomUUID)(),
        sessionId ?? null,
        message ?? "Issue reported",
        pageUrl ?? url ?? "unknown",
        browserInfo ?? "unknown",
        screenshot ?? null,
        screenshot ?? null,
        req.headers["user-agent"] ?? "",
    ]);
    return res["json"]({ success: true });
});
exports.default = router;
