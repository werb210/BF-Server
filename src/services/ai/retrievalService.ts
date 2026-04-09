import { db } from "../../db.js";
import { generateEmbedding } from "./embeddingService.js";

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

type KnowledgeRow = {
  content: string;
};

export async function retrieveRelevantContext(query: string): Promise<string> {
  const embedding = await generateEmbedding(query);

  const result = await db.query<KnowledgeRow>(
    `
    select content
    from ai_knowledge_documents
    where embedding is not null
    order by embedding <-> $1::vector
    limit 5
    `,
    [toVectorLiteral(embedding)]
  );

  return result.rows.map((row) => row.content).join("\n\n");
}
