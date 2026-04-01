import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db";
import { generateAIResponse } from "../modules/ai/ai.service";

const router = Router();

router.post("/ai/start", async (req: any, res: any, next: any) => {
  const id = randomUUID();

  await pool.runQuery(
    `insert into chat_sessions (id, crm_contact_id, source, status)
     values ($1, $2, $3, 'ai')`,
    [id, req.body.crmContactId ?? null, req.body.source]
  );

  res["json"]({ sessionId: id });
});

router.post("/ai/message", async (req: any, res: any, next: any) => {
  const { sessionId, message } = req.body as {
    sessionId: string;
    message: string;
  };

  await pool.runQuery(
    `insert into chat_messages (id, session_id, role, content)
     values ($1, $2, 'user', $3)`,
    [randomUUID(), sessionId, message]
  );

  const reply = await generateAIResponse(sessionId, message);

  res["json"](JSON.parse(reply) as unknown);
});

router.post("/ai/escalate", async (req: any, res: any, next: any) => {
  const { sessionId } = req.body as { sessionId: string };

  await pool.runQuery(
    `update chat_sessions set status = 'queued', updated_at = now()
     where id = $1`,
    [sessionId]
  );

  await pool.runQuery(
    `insert into chat_queue (id, session_id)
     values ($1, $2)`,
    [randomUUID(), sessionId]
  );

  res["json"]({ status: "queued" });
});

router.post("/ai/close", async (req: any, res: any, next: any) => {
  const { sessionId } = req.body as { sessionId: string };

  await pool.runQuery(
    `update chat_sessions set status = 'closed', updated_at = now()
     where id = $1`,
    [sessionId]
  );

  res["json"]({ status: "closed" });
});

router.post("/ai/confidence-check", async (req: any, res: any, next: any) => {
  const { sessionId, score, reason } = req.body as {
    sessionId: string;
    score: number;
    reason?: string;
  };

  await pool.runQuery(
    `insert into chat_messages (id, session_id, role, content, metadata)
     values ($1, $2, 'system', $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      "confidence_check",
      JSON.stringify({ score, reason: reason ?? null }),
    ]
  );

  res["json"]({ ok: true, escalateRecommended: score < 0.65 });
});

router.post("/ai/startup-interest", async (req: any, res: any, next: any) => {
  const { sessionId, tags } = req.body as {
    sessionId: string;
    tags: string[];
  };

  await pool.runQuery(
    `insert into chat_messages (id, session_id, role, content, metadata)
     values ($1, $2, 'system', $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      "startup_interest",
      JSON.stringify({ tags }),
    ]
  );

  res["json"]({ ok: true, tags });
});

export default router;
