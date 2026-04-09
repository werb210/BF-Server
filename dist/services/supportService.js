import { randomUUID } from "node:crypto";
import { dbQuery } from "../db.js";
import { logInfo } from "../observability/logger.js";
export async function createSupportThread(input) {
    const sessionId = randomUUID();
    await dbQuery(`insert into chat_sessions (id, user_type, status)
     values ($1, 'guest', 'escalated')`, [sessionId]);
    const payload = input.type === "chat_escalation"
        ? {
            type: input.type,
            source: input.source ?? null,
            transcript: input.transcript ?? null,
        }
        : {
            type: input.type,
            route: input.route ?? null,
            screenshotBase64: input.screenshotBase64 ?? null,
        };
    await dbQuery(`insert into chat_messages (id, session_id, role, message, metadata)
     values ($1, $2, 'user', $3, $4::jsonb)`, [
        randomUUID(),
        sessionId,
        input.description ?? "Support request",
        JSON.stringify(payload),
    ]);
    logInfo("audit_support_thread_created", {
        sessionId,
        type: input.type,
        ...(input.source ? { source: input.source } : {}),
        ...(input.route ? { route: input.route } : {}),
    });
    return sessionId;
}
