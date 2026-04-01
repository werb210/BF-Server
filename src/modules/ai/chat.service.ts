import { pool } from "../../db";
import { recordAuditEvent } from "../audit/audit.service";
import { generateAIResponse } from "./ai.service";
import {
  addMessage,
  createSession,
  fetchMessageCount,
  fetchSessionById,
  listMessagesBySession,
  listSessionsByStatus,
  type ChatMessageRecord,
  type ChatSessionRecord,
  updateSessionStatus,
} from "./chat.repo";

const MAX_MESSAGE_LENGTH = 2000;
const MAX_MESSAGES_BEFORE_COMPRESSION = 30;

function assertMessageLength(message: string): void {
  if (message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
}

async function upsertLead(params: {
  fullName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  tag: string;
}): Promise<string | null> {
  const email = params.email?.trim().toLowerCase() ?? null;
  const phone = params.phone?.trim() ?? null;

  const existing = await pool.runQuery<{ id: string }>(
    `select id from contacts where (email = $1 and $1 is not null) or (phone = $2 and $2 is not null) limit 1`,
    [email, phone]
  );

  const leadId = existing.rows[0]?.id;

  if (leadId) {
    await pool.runQuery(
      `update contacts
       set name = coalesce($2, name),
           email = coalesce($3, email),
           phone = coalesce($4, phone),
           updated_at = now()
       where id = $1`,
      [leadId, params.fullName ?? null, email, phone]
    );

    await recordAuditEvent({
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

  const created = await pool.runQuery<{ id: string }>(
    `insert into contacts (id, name, email, phone, status, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, 'prospect', now(), now())
     returning id`,
    [params.fullName ?? null, email, phone]
  );

  const createdLeadId = created.rows[0]?.id ?? null;

  if (createdLeadId) {
    await recordAuditEvent({
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

export async function startChatSession(params: {
  source: string;
  channel?: string;
  lead?: {
    fullName?: string;
    email?: string;
    phone?: string;
    companyName?: string;
  };
}): Promise<ChatSessionRecord> {
  const leadId = await upsertLead({ ...(params.lead ?? {}), tag: "chat_intake" });
  return createSession({ source: params.source, channel: params.channel, leadId });
}

export async function processChatMessage(params: {
  sessionId: string;
  message: string;
  source: string;
}): Promise<{ status: string; response: string; session: ChatSessionRecord }> {
  assertMessageLength(params.message);

  const session = await fetchSessionById(params.sessionId);
  if (!session) {
    throw new Error("Chat session not found.");
  }

  await addMessage({ sessionId: params.sessionId, role: "user", message: params.message, metadata: { source: params.source } });

  if (session.status !== "ai") {
    return { status: session.status, response: "A human specialist will continue this conversation shortly.", session };
  }

  const count = await fetchMessageCount(params.sessionId);
  if (count > MAX_MESSAGES_BEFORE_COMPRESSION) {
    await addMessage({
      sessionId: params.sessionId,
      role: "system",
      message: "Conversation compressed after 30 messages to preserve performance.",
      metadata: { compressed: true, originalMessageCount: count },
    });
  }

  const aiResponse = JSON.parse(await generateAIResponse(params.sessionId, params.message)) as { reply: string };
  await addMessage({ sessionId: params.sessionId, role: "ai", message: aiResponse.reply });

  return { status: session.status, response: aiResponse.reply, session };
}

export async function requestHumanTakeover(sessionId: string): Promise<void> {
  await updateSessionStatus(sessionId, "human");
  await recordAuditEvent({
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

export async function closeChatSession(sessionId: string): Promise<void> {
  await updateSessionStatus(sessionId, "closed");
}

export async function fetchHumanSessions(): Promise<ChatSessionRecord[]> {
  return listSessionsByStatus("human");
}

export async function fetchSessionMessages(sessionId: string): Promise<ChatMessageRecord[]> {
  return listMessagesBySession(sessionId);
}

export { upsertLead };
