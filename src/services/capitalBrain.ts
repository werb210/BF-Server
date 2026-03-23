import OpenAI from "openai";
import { config } from "../config";

function fetchAzureClient(): OpenAI {
  if (!config.azureOpenai.key || !config.azureOpenai.endpoint) {
    throw new Error("Azure OpenAI credentials are not configured.");
  }

  return new OpenAI({
    apiKey: config.azureOpenai.key,
    baseURL: config.azureOpenai.endpoint,
  });
}

export async function scorePreApplication(data: unknown): Promise<string | null> {
  if (!config.azureOpenai.deployment) {
    throw new Error("AZURE_OPENAI_DEPLOYMENT is not configured.");
  }

  const prompt = `
Evaluate this business for credit readiness.
Return a score from 1-10 and a short reason.

${JSON.stringify(data)}
`;

  const openai = fetchAzureClient();
  const response = await openai.chat.completions.create({
    model: config.azureOpenai.deployment,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content ?? null;
}
