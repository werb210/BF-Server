import { Router } from "express";
import { createSupportThread } from "../services/supportService.js";
import { pushLeadToCRM } from "../services/crmWebhook.js";
import { dbQuery } from "../db.js";
const router = Router();
router.post("/", async (req, res, next) => {
    const { message } = req.body;
    if (!message) {
        return res.status(400).json({ error: "Missing message" });
    }
    const { rows } = await dbQuery("select content from ai_knowledge order by created_at desc");
    const context = rows.map((row) => row.content).join("\n");
    const response = `AI Response based on knowledge: ${message}`;
    return res["json"]({ response, context });
});
router.post("/escalate", async (req, res, next) => {
    const { sessionId, transcript, source } = req.body;
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
    res["json"]({ escalated: true });
});
export default router;
