"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatHandler = chatHandler;
const openai_service_1 = require("./openai.service");
const session_service_1 = require("./session.service");
const SYSTEM_PROMPT = `
You are Maya, an AI assistant for Boreal Financial.
You must:
- Never name lenders.
- Always show ranges only.
- Always state "subject to underwriting".
- Never guarantee approval.
- Use institutional language.
`;
async function chatHandler(req, res) {
    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    const source = typeof req.body?.source === "string" ? req.body.source : "website";
    const sessionId = typeof req.body?.sessionId === "string" && req.body.sessionId.trim().length > 0
        ? req.body.sessionId
        : null;
    if (!message) {
        res.status(400).json({ error: "message is required" });
        return;
    }
    let session = sessionId;
    if (!session) {
        const createdSession = await (0, session_service_1.createSession)(source);
        session = createdSession.id;
    }
    await (0, session_service_1.addMessage)(session, "user", message, { source });
    const reply = await (0, openai_service_1.askAI)([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
    ]);
    await (0, session_service_1.addMessage)(session, "assistant", reply);
    res["json"]({
        sessionId: session,
        reply,
        message: reply,
        escalationAvailable: true,
        subjectToUnderwriting: true,
    });
}
