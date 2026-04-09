import { db } from "../../db.js";
import { generateEmbedding } from "./embeddingService.js";

export type KnowledgeSourceType = "lender_product" | "product_sheet" | "admin_rule";

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function ingestKnowledgeDocument(
  title: string,
  content: string,
  sourceType: KnowledgeSourceType
): Promise<void> {
  const embedding = await generateEmbedding(content);

  await db.query(
    `
    insert into ai_knowledge_documents (title, content, embedding, source_type)
    values ($1, $2, $3::vector, $4)
    `,
    [title, content, toVectorLiteral(embedding), sourceType]
  );
}
