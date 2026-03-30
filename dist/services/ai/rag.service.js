"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.embedText = embedText;
exports.searchRelevantDocs = searchRelevantDocs;
const db_1 = require("../../db");
const openai_service_1 = require("./openai.service");
const config_1 = require("../../config");
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
async function embedText(text) {
    const response = await openai_service_1.openai.embeddings.create({
        model: config_1.config.openai.embedModel ?? "text-embedding-3-small",
        input: text,
    });
    return response.data[0]?.embedding ?? [];
}
async function searchRelevantDocs(query) {
    const embedding = await embedText(query);
    const result = await db_1.pool.query(`
    select content
    from ai_embeddings
    where embedding is not null
    order by embedding <-> $1::vector
    limit 5
    `, [toVectorLiteral(embedding)]);
    return result.rows.map((row) => row.content);
}
