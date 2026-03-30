"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../db");
const knowledge_service_1 = require("./knowledge.service");
const router = (0, express_1.Router)();
router.post("/ai/rule", async (req, res, next) => {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) {
        res.status(400).json({ error: "content is required" });
        return;
    }
    await (0, knowledge_service_1.embedAndStore)(db_1.pool, content, "rule");
    res["json"]({ success: true });
});
exports.default = router;
