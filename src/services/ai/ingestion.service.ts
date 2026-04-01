import { v4 as uuid } from "uuid";
import { pool } from "../../db";
import { embedText } from "./rag.service";

const DEFAULT_CHUNK_SIZE = 1200;

export async function ingestProductEmbedding(params: {
  productId: string;
  productDescription: string;
}): Promise<void> {
  const embedding = await embedText(params.productDescription);

  await pool.runQuery(
    `insert into ai_embeddings (id, source_type, source_id, content, embedding)
     values ($1, $2, $3, $4, $5::vector)`,
    [uuid(), "product", params.productId, params.productDescription, `[${embedding.join(",")}]`]
  );
}

function chunkText(text: string, chunkSize = DEFAULT_CHUNK_SIZE): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }

  const chunks: string[] = [];
  for (let start = 0; start < normalized.length; start += chunkSize) {
    chunks.push(normalized.slice(start, start + chunkSize));
  }
  return chunks;
}

export async function ingestPdfText(params: {
  sourceId: string;
  extractedText: string;
}): Promise<number> {
  const chunks = chunkText(params.extractedText);

  for (const chunk of chunks) {
    const embedding = await embedText(chunk);
    await pool.runQuery(
      `insert into ai_embeddings (id, source_type, source_id, content, embedding)
       values ($1, $2, $3, $4, $5::vector)`,
      [uuid(), "pdf", params.sourceId, chunk, `[${embedding.join(",")}]`]
    );
  }

  return chunks.length;
}
