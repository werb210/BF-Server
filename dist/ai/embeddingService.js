import OpenAI from "openai";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { runQuery } from "../db.js";
const APPROX_CHUNK_SIZE = 800;
function hashToVector(text, length = 64) {
    const digest = createHash("sha256").update(text).digest();
    const vector = [];
    for (let i = 0; i < length; i += 1) {
        const value = (digest[i % digest.length] ?? 0) / 255;
        vector.push(value * 2 - 1);
    }
    return vector;
}
export function chunkText(input, chunkSize = APPROX_CHUNK_SIZE) {
    const tokens = input.split(/\s+/).filter(Boolean);
    if (tokens.length === 0)
        return [];
    const chunks = [];
    for (let i = 0; i < tokens.length; i += chunkSize) {
        chunks.push(tokens.slice(i, i + chunkSize).join(" "));
    }
    return chunks;
}
export async function generateEmbedding(text, client) {
    if (config.env === "test") {
        return new Array(1536).fill(0.01);
    }
    const trimmed = text.trim();
    if (!trimmed)
        return [];
    const apiKey = config.openai.apiKey;
    if (!apiKey && !client) {
        return hashToVector(trimmed);
    }
    const openai = client ?? new OpenAI({ apiKey });
    const response = await openai.embeddings.create({
        model: config.ai.embeddingModel,
        input: trimmed,
    });
    return response.data[0]?.embedding ?? [];
}
export async function embedTextByChunks(text, client) {
    const chunks = chunkText(text);
    if (chunks.length === 0)
        return [];
    const vectors = await Promise.all(chunks.map((chunk) => generateEmbedding(chunk, client)));
    return vectors;
}
export async function extractTextFromBuffer(fileBuffer, mimeType) {
    if (mimeType === "application/pdf") {
        const pdfParse = require("pdf-parse");
        const parsed = await pdfParse(fileBuffer);
        return parsed.text ?? "";
    }
    return fileBuffer.toString("utf8");
}
export async function ingestKnowledgeDocument(params) {
    const documentId = randomUUID();
    await runQuery(`insert into ai_knowledge_documents (id, filename, category, active, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`, [documentId, params.filename, params.category]);
    const chunks = chunkText(params.content);
    let count = 0;
    for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        await runQuery(`insert into ai_knowledge_chunks (id, document_id, content, embedding, created_at)
       values ($1, $2, $3, $4::jsonb, now())`, [randomUUID(), documentId, chunk, JSON.stringify(embedding)]);
        count += 1;
    }
    return { documentId, chunksInserted: count };
}
