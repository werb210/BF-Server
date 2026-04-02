"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestProductEmbedding = ingestProductEmbedding;
exports.ingestPdfText = ingestPdfText;
const uuid_1 = require("uuid");
const db_1 = require("../../db");
const rag_service_1 = require("./rag.service");
const DEFAULT_CHUNK_SIZE = 1200;
async function ingestProductEmbedding(params) {
    const embedding = await (0, rag_service_1.embedText)(params.productDescription);
    await (0, db_1.runQuery)(`insert into ai_embeddings (id, source_type, source_id, content, embedding)
     values ($1, $2, $3, $4, $5::vector)`, [(0, uuid_1.v4)(), "product", params.productId, params.productDescription, `[${embedding.join(",")}]`]);
}
function chunkText(text, chunkSize = DEFAULT_CHUNK_SIZE) {
    const normalized = text.trim();
    if (!normalized) {
        return [];
    }
    const chunks = [];
    for (let start = 0; start < normalized.length; start += chunkSize) {
        chunks.push(normalized.slice(start, start + chunkSize));
    }
    return chunks;
}
async function ingestPdfText(params) {
    const chunks = chunkText(params.extractedText);
    for (const chunk of chunks) {
        const embedding = await (0, rag_service_1.embedText)(chunk);
        await (0, db_1.runQuery)(`insert into ai_embeddings (id, source_type, source_id, content, embedding)
       values ($1, $2, $3, $4, $5::vector)`, [(0, uuid_1.v4)(), "pdf", params.sourceId, chunk, `[${embedding.join(",")}]`]);
    }
    return chunks.length;
}
