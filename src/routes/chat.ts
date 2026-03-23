import { Router } from "express";
import { createSupportThread } from "../services/supportService";
import { pushLeadToCRM } from "../services/crmWebhook";
import { dbQuery } from "../db";

const router = Router();

router.post("/", async (req: any, res: any, next: any) => {
  const { message } = req.body as { message?: string };

  if (!message) {
    return res.status(400).json({ error: "Missing message" });
  }

  const { rows } = await dbQuery<{ content: string }>(
    "select content from ai_knowledge order by created_at desc"
  );
  const context = rows.map((row) => row.content).join("\n");

  const response = `AI Response based on knowledge: ${message}`;

  return res.json({ response, context });
});

router.post("/escalate", async (req: any, res: any, next: any) => {
  const { sessionId, transcript, source } = req.body as {
    sessionId?: string;
    transcript?: unknown;
    source?: string;
  };

  await createSupportThread({
    type: "chat_escalation",
    ...(source ? { source } : {}),
    transcript: {
      sessionId: sessionId ?? null,
      transcript: transcript ?? null,
    },
  });

  await pushLeadToCRM({
    type: "chat_escalation",
    sessionId: sessionId ?? null,
    source: source ?? null,
    transcript: transcript ?? null,
  });

  res.json({ escalated: true });
});

export default router;
