"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cosineSimilarity = cosineSimilarity;
exports.retrieveTopKnowledgeChunks = retrieveTopKnowledgeChunks;
const db_1 = require("../db");
const embeddingService_1 = require("./embeddingService");
function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
function parseEmbedding(input) {
    if (Array.isArray(input) && input.every((v) => typeof v === "number")) {
        return input;
    }
    if (typeof input === "string") {
        try {
            const parsed = JSON.parse(input);
            if (Array.isArray(parsed) && parsed.every((v) => typeof v === "number")) {
                return parsed;
            }
        }
        catch {
            return [];
        }
    }
    return [];
}
async function retrieveTopKnowledgeChunks(question, limit = 5) {
    const queryVector = await (0, embeddingService_1.generateEmbedding)(question);
    const { rows } = await (0, db_1.runQuery)(`select id, document_id, content, embedding
     from ai_knowledge_chunks
     order by created_at desc
     limit 500`);
    return rows
        .map((row) => ({
        id: row.id,
        documentId: row.document_id,
        content: row.content,
        similarity: cosineSimilarity(queryVector, parseEmbedding(row.embedding)),
    }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
}
