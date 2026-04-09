import { Router } from "express";
import { randomUUID } from "node:crypto";
import { runQuery } from "../db.js";
import { generateAIResponse } from "../modules/ai/ai.service.js";
const router = Router();
router.post("/ai/start", async (req, res, next) => {
    const id = randomUUID();
    await runQuery(`insert into chat_sessions (id, crm_contact_id, source, status)
     values ($1, $2, $3, 'ai')`, [id, req.body.crmContactId ?? null, req.body.source]);
    res["json"]({ sessionId: id });
});
router.post("/ai/message", async (req, res, next) => {
    const { sessionId, message } = req.body;
    await runQuery(`insert into chat_messages (id, session_id, role, content)
     values ($1, $2, 'user', $3)`, [randomUUID(), sessionId, message]);
    const reply = await generateAIResponse(sessionId, message);
    res["json"](JSON.parse(reply));
});
router.post("/ai/escalate", async (req, res, next) => {
    const { sessionId } = req.body;
    await runQuery(`update chat_sessions set status = 'queued', updated_at = now()
     where id = $1`, [sessionId]);
    await runQuery(`insert into chat_queue (id, session_id)
     values ($1, $2)`, [randomUUID(), sessionId]);
    res["json"]({ status: "queued" });
});
router.post("/ai/close", async (req, res, next) => {
    const { sessionId } = req.body;
    await runQuery(`update chat_sessions set status = 'closed', updated_at = now()
     where id = $1`, [sessionId]);
    res["json"]({ status: "closed" });
});
router.post("/ai/confidence-check", async (req, res, next) => {
    const { sessionId, score, reason } = req.body;
    await runQuery(`insert into chat_messages (id, session_id, role, content, metadata)
     values ($1, $2, 'system', $3, $4::jsonb)`, [
        randomUUID(),
        sessionId,
        "confidence_check",
        JSON.stringify({ score, reason: reason ?? null }),
    ]);
    res["json"]({ ok: true, escalateRecommended: score < 0.65 });
});
router.post("/ai/startup-interest", async (req, res, next) => {
    const { sessionId, tags } = req.body;
    await runQuery(`insert into chat_messages (id, session_id, role, content, metadata)
     values ($1, $2, 'system', $3, $4::jsonb)`, [
        randomUUID(),
        sessionId,
        "startup_interest",
        JSON.stringify({ tags }),
    ]);
    res["json"]({ ok: true, tags });
});
export default router;
