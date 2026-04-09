import { dbQuery } from "../db.js";
import { logInfo } from "../observability/logger.js";
export async function saveKnowledge({ title, content, sourceType = "internal", }) {
    await dbQuery(`insert into ai_knowledge (title, content, source_type)
     values ($1, $2, $3)`, [title, content, sourceType]);
    logInfo("audit_ai_knowledge_saved", {
        title,
        sourceType,
        contentLength: content.length,
    });
}
