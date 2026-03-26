import OpenAI from "openai";
import { v4 as uuid } from "uuid";
import { AiMessage, AiSession } from "./ai.types";
import { dbQuery } from "../../db";
import { config } from "../../config";

type AiReply = {
  reply: string;
  askIntakeQuestions?: boolean;
};

const LENDER_LANGUAGE = "We have lenders across different capital types, including Institutional lenders, Banking, and Private Capital sources as well as our own funding offerings.";

const LEGACY_SYSTEM_PROMPT = [
  "You are a financing assistant for Boreal Financial.",
  "Output only valid JSON with keys: reply (string), askIntakeQuestions (boolean).",
  "Never name lenders.",
  LENDER_LANGUAGE,
  "Use range-based language for all rates, pricing, and limits.",
  "Never guarantee approvals.",
  "Never make fixed pricing promises.",
  "If user asks qualification-related questions, ask intake questions before recommendations.",
].join("\n");

const client = config.openai.apiKey
  ? new OpenAI({ apiKey: config.openai.apiKey })
  : null;

const sessions = new Map<string, AiSession>();
const messages: AiMessage[] = [];
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 500;
const MAX_MESSAGES = 500;

function trimMessages(): void {
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.createdAt.getTime() > SESSION_TTL_MS) {
      sessions.delete(sessionId);
    }
  }
}

setInterval(() => {
  pruneExpiredSessions();
}, 60_000).unref();


async function loadActiveAiRules(): Promise<string[]> {
  try {
    const modern = await dbQuery<{ rule_content: string }>(
      `select rule_content
       from ai_rules
       where active = true
       order by priority desc, id asc`
    );
    if (modern.rows.length > 0) {
      return modern.rows.map((row) => row.rule_content).filter(Boolean);
    }
  } catch {
    // fallback to legacy schema
  }

  try {
    const legacy = await dbQuery<{ rule_value: string }>(
      `select rule_value
       from ai_rules
       where coalesce(rule_value, '') <> ''
       order by updated_at desc`
    );
    return legacy.rows.map((row) => row.rule_value).filter(Boolean);
  } catch {
    return [];
  }
}

export function startSession(context: AiSession["context"]): AiSession {
  pruneExpiredSessions();
  const id = uuid();

  const session: AiSession = {
    id,
    context,
    escalated: false,
    createdAt: new Date(),
  };

  sessions.set(id, session);
  if (sessions.size > MAX_SESSIONS) {
    const firstKey = sessions.keys().next().value;
    if (firstKey) {
      sessions.delete(firstKey);
    }
  }

  return session;
}

export async function handleMessage(sessionId: string, content: string): Promise<{ reply: string }> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  messages.push({
    sessionId,
    role: "user",
    content,
    createdAt: new Date(),
  });
  trimMessages();

  const aiRules = await loadActiveAiRules();
  const systemPrompt = `
You are Maya, Boreal Financial AI assistant.
You are professional and friendly.
Never mention lender names.
Always show ranges only.
Never promise approval.
Never use underwriting disclaimer language.
If asked about startup funding, explain it is coming soon and offer to collect contact details.
Use exact capital language: "We have lenders across different capital types, including Institutional lenders, Banking, and Private Capital sources as well as our own funding offerings."
${aiRules.length > 0 ? `Admin override rules:
${aiRules.join("\n")}` : ""}
`;

  if (!client) {
    const fallbackReply = `${LENDER_LANGUAGE} Startup funding programs are coming soon; I can collect your contact details so our team can follow up.`;
    messages.push({
      sessionId,
      role: "assistant",
      content: fallbackReply,
      createdAt: new Date(),
    });
    trimMessages();
    return { reply: fallbackReply };
  }

  const response = await client.chat.completions.create({
    model: config.ai.model || "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
        .filter((messageItem) => messageItem.sessionId === sessionId)
        .map((messageItem) => ({
          role: messageItem.role,
          content: messageItem.content,
        })),
    ],
  });

  const reply = response.choices[0]?.message?.content || "";

  messages.push({
    sessionId,
    role: "assistant",
    content: reply,
    createdAt: new Date(),
  });
  trimMessages();

  return { reply };
}

export function escalate(sessionId: string): { success: true } {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error("Session not found");
  }

  session.escalated = true;

  return { success: true };
}

export function reportIssue(
  sessionId: string,
  message: string,
  screenshot?: string
): { success: true } {
  void { sessionId, message, screenshot };
  return { success: true };
}

export async function generateAIResponse(_sessionId: string, message: string): Promise<string> {
  if (!client) {
    return JSON.stringify({
      reply: `${LENDER_LANGUAGE} To guide qualification, could you share time in business, monthly revenue range, and existing obligations?`,
      askIntakeQuestions: true,
    } satisfies AiReply);
  }

  const aiRules = await loadActiveAiRules();

  const response = await client.chat.completions.create({
    model: config.openai.chatModel ?? "gpt-4.1-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${LEGACY_SYSTEM_PROMPT}\n${aiRules.length > 0 ? `Admin override rules:\n${aiRules.join("\n")}` : ""}` },
      { role: "user", content: message },
    ],
  });

  const responseContent = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(responseContent) as AiReply;

  if (typeof parsed.reply !== "string") {
    throw new Error("AI response format invalid: missing reply.");
  }

  return JSON.stringify({
    reply: parsed.reply,
    askIntakeQuestions: Boolean(parsed.askIntakeQuestions),
  } satisfies AiReply);
}
