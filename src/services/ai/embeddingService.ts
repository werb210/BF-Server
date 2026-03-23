import OpenAI from "openai";
import { config } from "../../config";

const client = new OpenAI({
  apiKey: config.openai.apiKey || "test-openai-key",
});

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.openai.embedModel ?? config.ai.embedModel ?? "text-embedding-3-small",
    input: text,
  });

  return response.data[0]?.embedding ?? [];
}
