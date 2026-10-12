import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool, runQuery } from "../db.js";
import { generateAIResponse } from "../modules/ai/ai.service.js";
import { auth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

const router = Router();

// BF_SERVER_v785_AI_STAFF_AUTH - the staff portal's AI page is the only caller;
// every route here is under /ai, so gate that prefix only (other /api/ai mounts
// such as /api/ai/maya are untouched).
router.use("/ai", auth);

router.post("/ai/start", safeHandler(async (req: any, res: any, next: any) => {
  const id = randomUUID();

  await runQuery(
    `insert into chat_sessions (id, crm_contact_id, source, status)
     values ($1, $2, coalesce($3, 'website'), 'ai')`,
    [id, req.body.crmContactId ?? null, req.body.source]
  );

  res["json"]({ sessionId: id });
}));

router.post("/ai/message", safeHandler(async (req: any, res: any, next: any) => {
  const { sessionId, message } = req.body as {
    sessionId: string;
    message: string;
  };

  await runQuery(
    // BF_SERVER_v784_CHAT_SCHEMA - live chat_messages has both message and
    // content NOT NULL; fill both.
    `insert into chat_messages (id, session_id, role, message, content)
     values ($1, $2, 'user', $3, $3)`,
    [randomUUID(), sessionId, message]
  );

  const reply = await generateAIResponse(sessionId, message);
  const parsed = JSON.parse(reply) as { reply?: unknown };

  // BF_SERVER_v785_AI_ASSISTANT_ROW - store Maya's reply too, so the transcript
  // is not one-sided. A failed insert is logged and does not fail the response.
  if (typeof parsed.reply === "string") {
    await runQuery(
      `insert into chat_messages (id, session_id, role, message, content)
       values ($1, $2, 'assistant', $3, $3)`,
      [randomUUID(), sessionId, parsed.reply]
    ).catch((err: any) => {
      console.warn("[silent-query] routes/ai.v2.ts assistant insert", { message: err?.message });
    });
  }

  res["json"](parsed as unknown);
}));

router.post("/ai/escalate", safeHandler(async (req: any, res: any, next: any) => {
  const { sessionId } = req.body as { sessionId: string };

  await runQuery(
    `update chat_sessions set status = 'queued', updated_at = now()
     where id = $1`,
    [sessionId]
  );

  await runQuery(
    `insert into chat_queue (id, session_id)
     values ($1, $2)`,
    [randomUUID(), sessionId]
  );

  res["json"]({ status: "queued" });
}));

router.post("/ai/close", safeHandler(async (req: any, res: any, next: any) => {
  const { sessionId } = req.body as { sessionId: string };

  await runQuery(
    `update chat_sessions set status = 'closed', updated_at = now()
     where id = $1`,
    [sessionId]
  );

  res["json"]({ status: "closed" });
}));

router.post("/ai/confidence-check", safeHandler(async (req: any, res: any, next: any) => {
  const { sessionId, score, reason } = req.body as {
    sessionId: string;
    score: number;
    reason?: string;
  };

  await runQuery(
    `insert into chat_messages (id, session_id, role, message, content, metadata)
     values ($1, $2, 'system', $3, $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      "confidence_check",
      JSON.stringify({ score, reason: reason ?? null }),
    ]
  );

  res["json"]({ ok: true, escalateRecommended: score < 0.65 });
}));

router.post("/ai/startup-interest", safeHandler(async (req: any, res: any, next: any) => {
  const { sessionId, tags } = req.body as {
    sessionId: string;
    tags: string[];
  };

  await runQuery(
    `insert into chat_messages (id, session_id, role, message, content, metadata)
     values ($1, $2, 'system', $3, $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      "startup_interest",
      JSON.stringify({ tags }),
    ]
  );

  res["json"]({ ok: true, tags });
}));

export default router;
