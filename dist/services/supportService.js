"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSupportThread = createSupportThread;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../db");
const logger_1 = require("../observability/logger");
async function createSupportThread(input) {
    const sessionId = (0, node_crypto_1.randomUUID)();
    await (0, db_1.dbQuery)(`insert into chat_sessions (id, user_type, status)
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
    await (0, db_1.dbQuery)(`insert into chat_messages (id, session_id, role, message, metadata)
     values ($1, $2, 'user', $3, $4::jsonb)`, [
        (0, node_crypto_1.randomUUID)(),
        sessionId,
        input.description ?? "Support request",
        JSON.stringify(payload),
    ]);
    (0, logger_1.logInfo)("audit_support_thread_created", {
        sessionId,
        type: input.type,
        ...(input.source ? { source: input.source } : {}),
        ...(input.route ? { route: input.route } : {}),
    });
    return sessionId;
}
