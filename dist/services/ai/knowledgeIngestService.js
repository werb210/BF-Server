"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestKnowledgeDocument = ingestKnowledgeDocument;
const db_1 = require("../../db");
const embeddingService_1 = require("./embeddingService");
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
async function ingestKnowledgeDocument(title, content, sourceType) {
    const embedding = await (0, embeddingService_1.generateEmbedding)(content);
    await db_1.db.query(`
    insert into ai_knowledge_documents (title, content, embedding, source_type)
    values ($1, $2, $3::vector, $4)
    `, [title, content, toVectorLiteral(embedding), sourceType]);
}
