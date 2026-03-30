"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveRelevantContext = retrieveRelevantContext;
const db_1 = require("../../db");
const embeddingService_1 = require("./embeddingService");
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
async function retrieveRelevantContext(query) {
    const embedding = await (0, embeddingService_1.generateEmbedding)(query);
    const result = await db_1.db.query(`
    select content
    from ai_knowledge_documents
    where embedding is not null
    order by embedding <-> $1::vector
    limit 5
    `, [toVectorLiteral(embedding)]);
    return result.rows.map((row) => row.content).join("\n\n");
}
