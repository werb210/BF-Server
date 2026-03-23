import OpenAI from "openai";

function fetchAzureClient(): OpenAI {
  if (!process.env.AZURE_OPENAI_KEY || !process.env.AZURE_OPENAI_ENDPOINT) {
    throw new Error("Azure OpenAI credentials are not configured.");
  }

  return new OpenAI({
    apiKey: process.env.AZURE_OPENAI_KEY,
    baseURL: process.env.AZURE_OPENAI_ENDPOINT,
  });
}

export async function scorePreApplication(data: unknown): Promise<string | null> {
  if (!process.env.AZURE_OPENAI_DEPLOYMENT) {
    throw new Error("AZURE_OPENAI_DEPLOYMENT is not configured.");
  }

  const prompt = `
Evaluate this business for credit readiness.
Return a score from 1-10 and a short reason.

${JSON.stringify(data)}
`;

  const openai = fetchAzureClient();
  const response = await openai.chat.completions.create({
    model: process.env.AZURE_OPENAI_DEPLOYMENT,
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0]?.message?.content ?? null;
}
