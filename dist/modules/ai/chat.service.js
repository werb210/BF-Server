"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startChatSession = startChatSession;
exports.processChatMessage = processChatMessage;
exports.requestHumanTakeover = requestHumanTakeover;
exports.closeChatSession = closeChatSession;
exports.fetchHumanSessions = fetchHumanSessions;
exports.fetchSessionMessages = fetchSessionMessages;
exports.upsertLead = upsertLead;
const db_1 = require("../../db");
const audit_service_1 = require("../audit/audit.service");
const ai_service_1 = require("./ai.service");
const chat_repo_1 = require("./chat.repo");
const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES_BEFORE_COMPRESSION = 30;
function assertMessageLength(message) {
    if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
        throw new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
    }
}
async function upsertLead(params) {
    const email = params.email?.trim().toLowerCase() ?? null;
    const phone = params.phone?.trim() ?? null;
    const existing = await (0, db_1.runQuery)(`select id from contacts where (email = $1 and $1 is not null) or (phone = $2 and $2 is not null) limit 1`, [email, phone]);
    const leadId = existing.rows[0]?.id;
    if (leadId) {
        await (0, db_1.runQuery)(`update contacts
       set name = coalesce($2, name),
           email = coalesce($3, email),
           phone = coalesce($4, phone),
           updated_at = now()
       where id = $1`, [leadId, params.fullName ?? null, email, phone]);
        await (0, audit_service_1.recordAuditEvent)({
            actorUserId: null,
            targetUserId: null,
            targetType: "contact",
            targetId: leadId,
            action: "crm_timeline",
            eventType: "crm_timeline",
            eventAction: "lead_updated",
            success: true,
            metadata: { tag: params.tag, companyName: params.companyName ?? null },
        });
        return leadId;
    }
    const created = await (0, db_1.runQuery)(`insert into contacts (id, name, email, phone, status, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, 'prospect', now(), now())
     returning id`, [params.fullName ?? null, email, phone]);
    const createdLeadId = created.rows[0]?.id ?? null;
    if (createdLeadId) {
        await (0, audit_service_1.recordAuditEvent)({
            actorUserId: null,
            targetUserId: null,
            targetType: "contact",
            targetId: createdLeadId,
            action: "crm_timeline",
            eventType: "crm_timeline",
            eventAction: "lead_created",
            success: true,
            metadata: { tag: params.tag, companyName: params.companyName ?? null },
        });
    }
    return createdLeadId;
}
async function startChatSession(params) {
    const leadId = await upsertLead({ ...(params.lead ?? {}), tag: "chat_intake" });
    return (0, chat_repo_1.createSession)({ source: params.source, channel: params.channel, leadId });
}
async function processChatMessage(params) {
    assertMessageLength(params.message);
    const session = await (0, chat_repo_1.fetchSessionById)(params.sessionId);
    if (!session) {
        throw new Error("Chat session not found.");
    }
    await (0, chat_repo_1.addMessage)({ sessionId: params.sessionId, role: "user", message: params.message, metadata: { source: params.source } });
    if (session.status !== "ai") {
        return { status: session.status, response: "A human specialist will continue this conversation shortly.", session };
    }
    const count = await (0, chat_repo_1.fetchMessageCount)(params.sessionId);
    if (count > MAX_MESSAGES_BEFORE_COMPRESSION) {
        await (0, chat_repo_1.addMessage)({
            sessionId: params.sessionId,
            role: "system",
            message: "Conversation compressed after 30 messages to preserve performance.",
            metadata: { compressed: true, originalMessageCount: count },
        });
    }
    const aiResponse = JSON.parse(await (0, ai_service_1.generateAIResponse)(params.sessionId, params.message));
    await (0, chat_repo_1.addMessage)({ sessionId: params.sessionId, role: "ai", message: aiResponse.reply });
    return { status: session.status, response: aiResponse.reply, session };
}
async function requestHumanTakeover(sessionId) {
    await (0, chat_repo_1.updateSessionStatus)(sessionId, "human");
    await (0, audit_service_1.recordAuditEvent)({
        actorUserId: null,
        targetUserId: null,
        targetType: "chat_session",
        targetId: sessionId,
        action: "crm_timeline",
        eventType: "crm_timeline",
        eventAction: "chat_human_takeover",
        success: true,
        metadata: { status: "human", portalNotification: "pending_websocket" },
    });
}
async function closeChatSession(sessionId) {
    await (0, chat_repo_1.updateSessionStatus)(sessionId, "closed");
}
async function fetchHumanSessions() {
    return (0, chat_repo_1.listSessionsByStatus)("human");
}
async function fetchSessionMessages(sessionId) {
    return (0, chat_repo_1.listMessagesBySession)(sessionId);
}
