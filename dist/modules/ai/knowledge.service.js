import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import { config } from "../../config/index.js";
const KNOWLEDGE_PATH = path.resolve("storage/knowledge.json");
let openaiClient = null;
function fetchOpenAIClient() {
    if (openaiClient) {
        return openaiClient;
    }
    const apiKey = config.openai.apiKey;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for AI knowledge embeddings.");
    }
    openaiClient = new OpenAI({ apiKey });
    return openaiClient;
}
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
function ensureStorageDir() {
    fs.mkdirSync(path.dirname(KNOWLEDGE_PATH), { recursive: true });
}
export function loadKnowledge() {
    if (!fs.existsSync(KNOWLEDGE_PATH))
        return [];
    const raw = fs.readFileSync(KNOWLEDGE_PATH, "utf8");
    if (!raw.trim())
        return [];
    return JSON.parse(raw);
}
export function saveKnowledge(entries) {
    ensureStorageDir();
    fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(entries, null, 2), "utf8");
}
export async function embedAndStore(db, content, sourceType, sourceId) {
    const embedding = await fetchOpenAIClient().embeddings.create({
        model: "text-embedding-3-small",
        input: content,
    });
    await db.query(`insert into ai_knowledge (id, source_type, source_id, content, embedding)
     values ($1, $2, $3, $4, $5::vector)`, (() => {
        const vector = embedding.data[0]?.embedding;
        if (!vector) {
            throw new Error("Failed to generate embedding.");
        }
        return [uuid(), sourceType, sourceId ?? null, content, toVectorLiteral(vector)];
    })());
}
export async function retrieveContext(db, question) {
    const embedding = await fetchOpenAIClient().embeddings.create({
        model: "text-embedding-3-small",
        input: question,
    });
    const result = await db.query(`
    select content
    from ai_knowledge
    where embedding is not null
    order by embedding <-> $1::vector
    limit 6
    `, [toVectorLiteral((() => { const v = embedding.data[0]?.embedding; if (!v) {
            throw new Error("Failed to generate embedding.");
        } return v; })())]);
    return result.rows.map((r) => r.content).join("\n\n");
}
