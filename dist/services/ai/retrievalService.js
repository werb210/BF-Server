import { db } from "../../db.js";
import { generateEmbedding } from "./embeddingService.js";
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
export async function retrieveRelevantContext(query) {
    const embedding = await generateEmbedding(query);
    const result = await db.query(`
    select content
    from ai_knowledge_documents
    where embedding is not null
    order by embedding <-> $1::vector
    limit 5
    `, [toVectorLiteral(embedding)]);
    return result.rows.map((row) => row.content).join("\n\n");
}
