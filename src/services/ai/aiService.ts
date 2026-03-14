import OpenAI from "openai";
import { db } from "../../db";
import { retrieveRelevantContext } from "./retrievalService";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "test-openai-key",
});

type RuleRow = {
  rule_key: string;
  rule_value: string;
};

async function loadSystemRules(): Promise<string> {
  const { rows } = await db.query<RuleRow>(
    `
    select rule_key, rule_value
    from ai_system_rules
    order by rule_key asc
    `
  );

  if (rows.length === 0) {
    return [
      "- Never mention lender names.",
      "- Always show ranges only.",
      "- Never give underwriting guarantees.",
      "- Never mention startup funding as available.",
      "- Use professional and friendly tone.",
      '- Say: "We have lenders across different capital types, including Institutional lenders, Banking, and Private Capital sources as well as our own funding offerings."',
    ].join("\n");
  }

  return rows.map((row) => `- ${row.rule_key}: ${row.rule_value}`).join("\n");
}

export async function generateAIResponse(userMessage: string): Promise<string> {
  const [context, rules] = await Promise.all([
    retrieveRelevantContext(userMessage),
    loadSystemRules(),
  ]);

  const systemName = process.env.AI_SYSTEM_NAME ?? "Maya";

  const systemPrompt = `
You are ${systemName}, Boreal Financial's AI assistant.

Rules:
${rules}

Knowledge:
${context}
`;

  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? process.env.AI_MODEL ?? "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}
