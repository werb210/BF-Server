import { runQuery } from "../../db.js";
import { openai } from "./openai.service.js";
import { config } from "../../config/index.js";
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
export async function embedText(text) {
    const response = await openai.embeddings.create({
        model: config.openai.embedModel ?? "text-embedding-3-small",
        input: text,
    });
    return response.data[0]?.embedding ?? [];
}
export async function searchRelevantDocs(query) {
    const embedding = await embedText(query);
    const result = await runQuery(`
    select content
    from ai_embeddings
    where embedding is not null
    order by embedding <-> $1::vector
    limit 5
    `, [toVectorLiteral(embedding)]);
    return result.rows.map((row) => row.content);
}
