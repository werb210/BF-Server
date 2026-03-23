import type { Request, Response } from "express";
import OpenAI from "openai";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { safeHandler } from "../middleware/safeHandler";
import { retrieveTopKnowledgeChunks } from "./retrievalService";
import { matchLenders } from "./lenderMatchEngine";
import { runtimeEnv } from "src/server/config/config";
import { emitAiEscalation } from "../realtime/events";
import { circuitGuard, recordFailure, resetCircuit } from "../utils/circuitBreaker";
import { retry } from "../utils/retry";

function detectIntent(message: string): "faq" | "prequal" | "escalation" {
  const lower = message.toLowerCase();
  if (lower.includes("agent") || lower.includes("human") || lower.includes("escalat")) {
    return "escalation";
  }
  if (
    ["revenue", "province", "amount", "prequal", "eligible", "time in business"].some((k) =>
      lower.includes(k)
    )
  ) {
    return "prequal";
  }
  return "faq";
}

function extractPrequalData(message: string): {
  revenue?: number;
  requestedAmount?: number;
  timeInBusiness?: number;
  province?: string;
} {
  const revenueMatch = message.match(/revenue[^\d]*(\d[\d,]*)/i);
  const amountMatch = message.match(/(?:amount|need|request)[^\d]*(\d[\d,]*)/i);
  const monthsMatch = message.match(/(\d{1,3})\s*(?:months?|mos?)/i);
  const provinceMatch = message.match(/\b(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)\b/i);
  const result: {
    revenue?: number;
    requestedAmount?: number;
    timeInBusiness?: number;
    province?: string;
  } = {};
  const revenueValue = revenueMatch?.[1];
  if (revenueValue) result.revenue = Number(revenueValue.replace(/,/g, ""));
  const amountValue = amountMatch?.[1];
  if (amountValue) result.requestedAmount = Number(amountValue.replace(/,/g, ""));
  const monthsValue = monthsMatch?.[1];
  if (monthsValue) result.timeInBusiness = Number(monthsValue);
  const provinceValue = provinceMatch?.[1];
  if (provinceValue) result.province = provinceValue.toUpperCase();
  return result;
}

async function createAiResponse(prompt: string, context: string[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return `I can help with Boreal Marketplace questions. Based on our knowledge base: ${context
      .slice(0, 2)
      .join(" ")}`;
  }

  const client = new OpenAI({ apiKey });
  const response = await retry(async () => {
    circuitGuard();
    try {
      const completion = await client.chat.completions.create({
        model: runtimeEnv.aiModel,
        messages: [
          {
            role: "system",
            content:
              "You are Boreal Marketplace AI. Position Boreal as a marketplace, never promise lender approval, and if data is missing say you do not know.",
          },
          {
            role: "user",
            content: `Question: ${prompt}\n\nContext:\n${context.join("\n---\n")}`,
          },
        ],
        temperature: 0.2,
      });
      resetCircuit();
      return completion;
    } catch (error) {
      recordFailure();
      throw error;
    }
  });

  return response.choices[0]?.message?.content ?? "I could not generate a response.";
}


export const postAiChat = safeHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    sessionId?: string;
    message?: string;
    userType?: "client" | "guest" | "portal";
  };

  if (!body.message || !body.message.trim()) {
    res.status(400).json({ code: "invalid_request", message: "message is required" });
    return;
  }

  const sessionId = body.sessionId ?? randomUUID();
  const userType = body.userType ?? "guest";
  await pool.query(
    `insert into chat_sessions (id, user_type, status, escalated_to, created_at, updated_at)
     values ($1, $2, 'active', null, now(), now())
     on conflict (id) do update set updated_at = now()`,
    [sessionId, userType]
  );

  await pool.query(
    `insert into chat_messages (id, session_id, role, message, metadata, created_at)
     values ($1, $2, 'user', $3, null, now())`,
    [randomUUID(), sessionId, body.message]
  );

  const intent = detectIntent(body.message);
  const prequal = extractPrequalData(body.message);
  const shouldStorePrequal =
    prequal.revenue !== undefined ||
    prequal.requestedAmount !== undefined ||
    prequal.timeInBusiness !== undefined ||
    prequal.province !== undefined;

  let lenderMatches: Awaited<ReturnType<typeof matchLenders>> | undefined;

  if (shouldStorePrequal) {
    await pool.query(
      `insert into ai_prequal_sessions
       (id, session_id, revenue, industry, time_in_business, province, requested_amount, lender_matches, created_at)
       values ($1, $2, $3, null, $4, $5, $6, $7::jsonb, now())`,
      [
        randomUUID(),
        sessionId,
        prequal.revenue ?? null,
        prequal.timeInBusiness ?? null,
        prequal.province ?? null,
        prequal.requestedAmount ?? null,
        JSON.stringify([]),
      ]
    );
  }

  if (intent === "prequal" && prequal.requestedAmount && prequal.revenue) {
    lenderMatches = await matchLenders({
      requestedAmount: prequal.requestedAmount,
      revenue: prequal.revenue,
      ...(prequal.timeInBusiness !== undefined
        ? { timeInBusiness: prequal.timeInBusiness }
        : {}),
      ...(prequal.province !== undefined ? { province: prequal.province } : {}),
    });

    await pool.query(
      `update ai_prequal_sessions
       set lender_matches = $2::jsonb
       where session_id = $1`,
      [sessionId, JSON.stringify(lenderMatches)]
    );
  }

  const knowledge = await retrieveTopKnowledgeChunks(body.message, 5);
  const aiMessage = await createAiResponse(
    body.message,
    knowledge.map((chunk) => chunk.content)
  );

  await pool.query(
    `insert into chat_messages (id, session_id, role, message, metadata, created_at)
     values ($1, $2, 'ai', $3, $4::jsonb, now())`,
    [randomUUID(), sessionId, aiMessage, JSON.stringify({ intent })]
  );

  res.status(200).json({
    sessionId,
    message: aiMessage,
    suggestions: [
      "Ask about lender criteria",
      "Check prequalification likelihood",
      "Request a human specialist",
    ],
    lenderMatches,
    escalationAvailable: true,
  });
});

export const postAiEscalate = safeHandler(async (req: Request, res: Response) => {
  const { sessionId, escalatedTo, messages } = req.body as {
    sessionId?: string;
    escalatedTo?: string;
    messages?: unknown;
  };
  if (!sessionId) {
    res.status(400).json({ code: "invalid_request", message: "sessionId is required" });
    return;
  }

  await pool.query(
    `update chat_sessions
     set status = 'escalated', escalated_to = $2, updated_at = now()
     where id = $1`,
    [sessionId, escalatedTo ?? null]
  );

  await pool.query(
    `insert into ai_escalations (id, session_id, messages, status, created_at)
     values ($1, $2, $3::jsonb, 'open', now())`,
    [randomUUID(), sessionId, JSON.stringify(messages ?? [])]
  );

  emitAiEscalation({
    sessionId,
    escalatedTo: escalatedTo ?? null,
    triggeredBy: req.user?.userId ?? null,
    timestamp: new Date().toISOString(),
  });

  res.status(200).json({ ok: true });
});
