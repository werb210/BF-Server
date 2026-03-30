"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadKnowledge = loadKnowledge;
exports.saveKnowledge = saveKnowledge;
exports.embedAndStore = embedAndStore;
exports.retrieveContext = retrieveContext;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const openai_1 = __importDefault(require("openai"));
const uuid_1 = require("uuid");
const config_1 = require("../../config");
const KNOWLEDGE_PATH = node_path_1.default.resolve("storage/knowledge.json");
let openaiClient = null;
function fetchOpenAIClient() {
    if (openaiClient) {
        return openaiClient;
    }
    const apiKey = config_1.config.openai.apiKey;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for AI knowledge embeddings.");
    }
    openaiClient = new openai_1.default({ apiKey });
    return openaiClient;
}
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
function ensureStorageDir() {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(KNOWLEDGE_PATH), { recursive: true });
}
function loadKnowledge() {
    if (!node_fs_1.default.existsSync(KNOWLEDGE_PATH))
        return [];
    const raw = node_fs_1.default.readFileSync(KNOWLEDGE_PATH, "utf8");
    if (!raw.trim())
        return [];
    return JSON.parse(raw);
}
function saveKnowledge(entries) {
    ensureStorageDir();
    node_fs_1.default.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(entries, null, 2), "utf8");
}
async function embedAndStore(db, content, sourceType, sourceId) {
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
        return [(0, uuid_1.v4)(), sourceType, sourceId ?? null, content, toVectorLiteral(vector)];
    })());
}
async function retrieveContext(db, question) {
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
