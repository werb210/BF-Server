import { db } from "../../db.js";
import { generateEmbedding } from "./embeddingService.js";
function toVectorLiteral(values) {
    return `[${values.join(",")}]`;
}
export async function ingestKnowledgeDocument(title, content, sourceType) {
    const embedding = await generateEmbedding(content);
    await db.query(`
    insert into ai_knowledge_documents (title, content, embedding, source_type)
    values ($1, $2, $3::vector, $4)
    `, [title, content, toVectorLiteral(embedding), sourceType]);
}
