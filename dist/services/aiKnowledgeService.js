"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveKnowledge = saveKnowledge;
const db_1 = require("../db");
const logger_1 = require("../observability/logger");
async function saveKnowledge({ title, content, sourceType = "internal", }) {
    await (0, db_1.dbQuery)(`insert into ai_knowledge (title, content, source_type)
     values ($1, $2, $3)`, [title, content, sourceType]);
    (0, logger_1.logInfo)("audit_ai_knowledge_saved", {
        title,
        sourceType,
        contentLength: content.length,
    });
}
