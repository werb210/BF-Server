import { Request, Response } from "express";
import { askAI } from "./openai.service.js";
import { addMessage, createSession } from "./session.service.js";

const SYSTEM_PROMPT = `
You are Maya, an AI assistant for Boreal Financial.
You must:
- Never name lenders.
- Always show ranges only.
- Always state "subject to underwriting".
- Never guarantee approval.
- Use institutional language.
`;

export async function chatHandler(req: Request, res: Response): Promise<void> {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const source = typeof req.body?.source === "string" ? req.body.source : "website";
  const sessionId =
    typeof req.body?.sessionId === "string" && req.body.sessionId.trim().length > 0
      ? req.body.sessionId
      : null;

  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  let session = sessionId;

  if (!session) {
    const createdSession = await createSession(source);
    session = createdSession.id;
  }

  await addMessage(session, "user", message, { source });

  const reply = await askAI([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message },
  ]);

  await addMessage(session, "assistant", reply);

  res["json"]({
    sessionId: session,
    reply,
    message: reply,
    escalationAvailable: true,
    subjectToUnderwriting: true,
  });
}
