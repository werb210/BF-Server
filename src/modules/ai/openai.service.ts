import OpenAI from "openai";
import { config } from "../../config";

type ChatRole = "system" | "user" | "assistant";

export type AIMessage = {
  role: ChatRole;
  content: string;
};

let client: OpenAI | null = null;

function fetchClient(): OpenAI {
  if (client) return client;

  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for AI chat.");
  }

  client = new OpenAI({ apiKey });
  return client;
}

export async function askAI(messages: AIMessage[]): Promise<string> {
  const completion = await fetchClient().chat.completions.create({
    model: config.openai.chatModel ?? "gpt-4o-mini",
    messages,
    temperature: 0.4,
  });

  return completion.choices[0]?.message?.content ?? "No response.";
}
