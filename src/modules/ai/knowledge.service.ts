import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import { config } from "@/config";

type KnowledgeEntry = {
  title: string;
  content: string;
  createdAt: string;
};

const KNOWLEDGE_PATH = path.resolve("storage/knowledge.json");
let openaiClient: OpenAI | null = null;

function fetchOpenAIClient(): OpenAI {
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

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function ensureStorageDir(): void {
  fs.mkdirSync(path.dirname(KNOWLEDGE_PATH), { recursive: true });
}

export function loadKnowledge(): KnowledgeEntry[] {
  if (!fs.existsSync(KNOWLEDGE_PATH)) return [];
  const raw = fs.readFileSync(KNOWLEDGE_PATH, "utf8");
  if (!raw.trim()) return [];
  return JSON.parse(raw) as KnowledgeEntry[];
}

export function saveKnowledge(entries: KnowledgeEntry[]): void {
  ensureStorageDir();
  fs.writeFileSync(KNOWLEDGE_PATH, JSON.stringify(entries, null, 2), "utf8");
}

type Queryable = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

export async function embedAndStore(
  db: Queryable,
  content: string,
  sourceType: string,
  sourceId?: string
): Promise<void> {
  const embedding = await fetchOpenAIClient().embeddings.create({
    model: "text-embedding-3-small",
    input: content,
  });

  await db.query(
    `insert into ai_knowledge (id, source_type, source_id, content, embedding)
     values ($1, $2, $3, $4, $5::vector)`,
    (() => {
      const vector = embedding.data[0]?.embedding;
      if (!vector) {
        throw new Error("Failed to generate embedding.");
      }
      return [uuid(), sourceType, sourceId ?? null, content, toVectorLiteral(vector)];
    })()
  );
}

export async function retrieveContext(
  db: Queryable,
  question: string
): Promise<string> {
  const embedding = await fetchOpenAIClient().embeddings.create({
    model: "text-embedding-3-small",
    input: question,
  });

  const result = await db.query<{ content: string }>(
    `
    select content
    from ai_knowledge
    where embedding is not null
    order by embedding <-> $1::vector
    limit 6
    `,
    [toVectorLiteral((() => { const v = embedding.data[0]?.embedding; if (!v) { throw new Error("Failed to generate embedding."); } return v; })())]
  );

  return result.rows.map((r) => r.content).join("\n\n");
}

export type { KnowledgeEntry };
