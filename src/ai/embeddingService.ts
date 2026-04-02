import OpenAI from "openai";
import { createHash, randomUUID } from "crypto";
import { config } from "../config";
import { pool, runQuery } from "../db";

const APPROX_CHUNK_SIZE = 800;

function hashToVector(text: string, length = 64): number[] {
  const digest = createHash("sha256").update(text).digest();
  const vector: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const value = (digest[i % digest.length] ?? 0) / 255;
    vector.push(value * 2 - 1);
  }
  return vector;
}

export function chunkText(input: string, chunkSize = APPROX_CHUNK_SIZE): string[] {
  const tokens = input.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += chunkSize) {
    chunks.push(tokens.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
}

export async function generateEmbedding(
  text: string,
  client?: OpenAI
): Promise<number[]> {
  if (config.env === "test") {
    return new Array(1536).fill(0.01);
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
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

export async function embedTextByChunks(text: string, client?: OpenAI): Promise<number[][]> {
  const chunks = chunkText(text);
  if (chunks.length === 0) return [];
  const vectors = await Promise.all(chunks.map((chunk) => generateEmbedding(chunk, client)));
  return vectors;
}


export async function extractTextFromBuffer(fileBuffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === "application/pdf") {
    const pdfParse = require("pdf-parse") as (input: Buffer) => Promise<{ text?: string }>;
    const parsed = await pdfParse(fileBuffer);
    return parsed.text ?? "";
  }
  return fileBuffer.toString("utf8");
}

export async function ingestKnowledgeDocument(params: {
  filename: string;
  category: "product" | "lender" | "underwriting" | "process";
  content: string;
}): Promise<{ documentId: string; chunksInserted: number }> {
  const documentId = randomUUID();
  await runQuery(
    `insert into ai_knowledge_documents (id, filename, category, active, created_at, updated_at)
     values ($1, $2, $3, true, now(), now())`,
    [documentId, params.filename, params.category]
  );

  const chunks = chunkText(params.content);
  let count = 0;
  for (const chunk of chunks) {
    const embedding = await generateEmbedding(chunk);
    await runQuery(
      `insert into ai_knowledge_chunks (id, document_id, content, embedding, created_at)
       values ($1, $2, $3, $4::jsonb, now())`,
      [randomUUID(), documentId, chunk, JSON.stringify(embedding)]
    );
    count += 1;
  }

  return { documentId, chunksInserted: count };
}
