import { Router } from "express";
import { randomUUID } from "node:crypto";
import { dbQuery } from "../db";

const router = Router();

router.post("/", async (req: any, res: any, next: any) => {
  const { name, email, conversation } = req.body as {
    name?: string;
    email?: string;
    conversation?: unknown;
  };

  const sessionId = randomUUID();

  await dbQuery(
    `insert into chat_sessions (id, user_type, status)
     values ($1, 'guest', 'escalated')`,
    [sessionId]
  );

  await dbQuery(
    `insert into chat_messages (id, session_id, role, message, metadata)
     values ($1, $2, 'user', $3, $4::jsonb)`,
    [
      randomUUID(),
      sessionId,
      "Chat escalation request",
      JSON.stringify({ name: name ?? null, email: email ?? null, conversation: conversation ?? null }),
    ]
  );

  return res.json({ success: true, sessionId });
});

export default router;
