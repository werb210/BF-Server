"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunkText = chunkText;
exports.generateEmbedding = generateEmbedding;
exports.embedTextByChunks = embedTextByChunks;
exports.extractTextFromBuffer = extractTextFromBuffer;
exports.ingestKnowledgeDocument = ingestKnowledgeDocument;
const openai_1 = __importDefault(require("openai"));
const crypto_1 = require("crypto");
const config_1 = require("../config");
const db_1 = require("../db");
const APPROX_CHUNK_SIZE = 800;
function hashToVector(text, length = 64) {
    const digest = (0, crypto_1.createHash)("sha256").update(text).digest();
    const vector = [];
    for (let i = 0; i < length; i += 1) {
        const value = (digest[i % digest.length] ?? 0) / 255;
        vector.push(value * 2 - 1);
    }
    return vector;
}
function chunkText(input, chunkSize = APPROX_CHUNK_SIZE) {
    const tokens = input.split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return [];
    const chunks = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
        chunks.push(tokens.slice(i, i + chunkSize).join(" "));
    }
    return chunks;
}
async function generateEmbedding(text, client) {
    if (config_1.config.env === "test") {
        return new Array(1536).fill(0.01);
    }
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const apiKey = config_1.config.openai.apiKey;
    if (!apiKey && !client) {
        return hashToVector(trimmed);
    }
    const openai = client ?? new openai_1.default({ apiKey });
    const response = await openai.embeddings.create({
        model: config_1.config.ai.embeddingModel,
        input: trimmed,
    });
    return response.data[0]?.embedding ?? [];
}
async function embedTextByChunks(text, client) {
    const chunks = chunkText(text);
    if (chunks.length === 0)
        return [];
    const vectors = await Promise.all(chunks.map((chunk) => generateEmbedding(chunk, client)));
    return vectors;
}
async function extractTextFromBuffer(fileBuffer, mimeType) {
    if (mimeType === "application/pdf") {
        const pdfParse = require("pdf-parse");
        const parsed = await pdfParse(fileBuffer);
        return parsed.text ?? "";
    }
    return fileBuffer.toString("utf8");
}
async function ingestKnowledgeDocument(params) {
    const documentId = (0, crypto_1.randomUUID)();
    await db_1.pool.runQuery(`insert into ai_knowledge_documents (id, filename, category, active, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`, [documentId, params.filename, params.category]);
    const chunks = chunkText(params.content);
    let count = 0;
    for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        await db_1.pool.runQuery(`insert into ai_knowledge_chunks (id, document_id, content, embedding, created_at)
       values ($1, $2, $3, $4::jsonb, now())`, [(0, crypto_1.randomUUID)(), documentId, chunk, JSON.stringify(embedding)]);
        count += 1;
    }
    return { documentId, chunksInserted: count };
}
