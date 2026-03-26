import type { Server } from "http";
import { randomUUID } from "crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { pool } from "../../db";
import { logError, logInfo } from "../../observability/logger";

type SessionSocket = WebSocket & { sessionId?: string; isAlive?: boolean; role?: "client" | "staff"; userId?: string };

type ChatSessionState = "AI_ACTIVE" | "HUMAN_ACTIVE";

type SessionPresence = {
  state: ChatSessionState;
  sockets: Set<SessionSocket>;
  updatedAt: number;
};

type SocketPayload = {
  type?: string;
  sessionId?: string;
  content?: string;
  userId?: string;
};

const sessionMap = new Map<string, SessionPresence>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_WS_SESSIONS = 1000;

function pruneSessionPresence(now = Date.now()): void {
  for (const [sessionId, presence] of sessionMap.entries()) {
    if (presence.sockets.size === 0 || now - presence.updatedAt > SESSION_TTL_MS) {
      sessionMap.delete(sessionId);
    }
  }
}

function safeParsePayload(data: RawData): SocketPayload | null {
  try {
    return JSON.parse(data.toString()) as SocketPayload;
  } catch {
    return null;
  }
}

function ensurePresence(sessionId: string): SessionPresence {
  pruneSessionPresence();
  const existing = sessionMap.get(sessionId);
  if (existing) {
    return existing;
  }
  const created: SessionPresence = {
    state: "AI_ACTIVE",
    sockets: new Set<SessionSocket>(),
    updatedAt: Date.now(),
  };
  sessionMap.set(sessionId, created);
  if (sessionMap.size > MAX_WS_SESSIONS) {
    const firstKey = sessionMap.keys().next().value;
    if (firstKey) {
      sessionMap.delete(firstKey);
    }
  }
  return created;
}

function broadcast(sessionId: string, payload: Record<string, unknown>): void {
  const presence = sessionMap.get(sessionId);
  if (!presence) {
    return;
  }

  const encoded = JSON.stringify(payload);
  for (const socket of presence.sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(encoded);
    }
  }
}

async function ensureChatSessionExists(sessionId: string): Promise<void> {
  try {
    await pool.query(
      `insert into chat_sessions (id, source, channel, status)
       values ($1, 'website', 'text', 'ai')
       on conflict (id) do nothing`,
      [sessionId]
    );
    return;
  } catch {
    // continue to legacy fallback
  }

  try {
    await pool.query(
      `insert into chat_sessions (id, user_type, status, source)
       values ($1, 'guest', 'active', 'website')
       on conflict (id) do nothing`,
      [sessionId]
    );
  } catch {
    // Some deployments own session creation elsewhere; do not fail websocket join.
  }
}

async function attachTranscriptToCrm(sessionId: string): Promise<void> {
  const sessionResult = await pool.query<{ lead_id: string | null }>(
    "select lead_id from chat_sessions where id = $1 limit 1",
    [sessionId]
  );
  const leadId = sessionResult.rows[0]?.lead_id;
  if (!leadId) return;

  const messages = await pool.query<{ role: string; message: string | null; content: string | null; created_at: string }>(
    `select role, message, content, created_at
     from chat_messages
     where session_id = $1
     order by created_at asc`,
    [sessionId]
  );

  await pool.query(
    `insert into crm_lead_activities (id, lead_id, activity_type, payload)
     values ($1, $2, $3, $4::jsonb)`,
    [
      randomUUID(),
      leadId,
      "chat_transcript_closed",
      JSON.stringify({ sessionId, transcript: messages.rows }),
    ]
  );
}

async function setSessionState(sessionId: string, state: ChatSessionState): Promise<void> {
  const presence = ensurePresence(sessionId);
  presence.state = state;
  presence.updatedAt = Date.now();

  await pool.query(
    `update chat_sessions
     set status = $2,
         staff_override = $3,
         updated_at = now()
     where id = $1`,
    [sessionId, state === "HUMAN_ACTIVE" ? "human" : "active", state === "HUMAN_ACTIVE"]
  ).catch(async () => {
    await pool.query(
      `update chat_sessions
       set status = $2,
           updated_at = now()
       where id = $1`,
      [sessionId, state === "HUMAN_ACTIVE" ? "escalated" : "active"]
    ).catch(() => undefined);
  });

  logInfo("chat_session_state_changed", { sessionId, state });
}

function detachSocket(socket: SessionSocket): void {
  if (!socket.sessionId) {
    return;
  }
  const presence = sessionMap.get(socket.sessionId);
  if (!presence) {
    return;
  }

  presence.sockets.delete(socket);
  presence.updatedAt = Date.now();

  if (presence.sockets.size === 0) {
    sessionMap.delete(socket.sessionId);
    void attachTranscriptToCrm(socket.sessionId).catch((error) => {
      logError("chat_transcript_attach_on_close_failed", {
        message: error instanceof Error ? error.message : String(error),
        sessionId: socket.sessionId,
      });
    });
  }
}

export function initChatSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws/chat" });

  setInterval(() => {
    pruneSessionPresence();
  }, 60_000).unref();

  wss.on("connection", (ws: SessionSocket) => {
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", async (data: RawData) => {
      try {
        const payload = safeParsePayload(data);
        if (!payload) {
          ws.send(JSON.stringify({ type: "error", message: "invalid_payload" }));
          return;
        }

        const messageType = payload.type;

        if ((messageType === "join_session" || messageType === "connect") && payload.sessionId) {
          if (!payload.userId || payload.userId.trim().length === 0) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }
          ws.sessionId = payload.sessionId;
          ws.role = "client";
          ws.userId = payload.userId;

          await ensureChatSessionExists(payload.sessionId);

          const presence = ensurePresence(payload.sessionId);
          presence.sockets.add(ws);
          presence.updatedAt = Date.now();

          ws.send(JSON.stringify({
            type: "joined",
            sessionId: payload.sessionId,
            reconnect: true,
            state: presence.state,
          }));
          if (presence.state === "HUMAN_ACTIVE") {
            ws.send(JSON.stringify({
              type: "transferring",
              sessionId: payload.sessionId,
              state: "HUMAN_ACTIVE",
            }));
          }
          logInfo("chat_ws_join", { sessionId: payload.sessionId, role: "client" });
          return;
        }

        if ((messageType === "staff_join" || messageType === "staff_joined") && payload.sessionId) {
          if (!payload.userId || payload.userId.trim().length === 0) {
            ws.send(JSON.stringify({ type: "error", message: "unauthorized" }));
            return;
          }
          ws.sessionId = payload.sessionId;
          ws.role = "staff";
          ws.userId = payload.userId;

          await ensureChatSessionExists(payload.sessionId);

          const presence = ensurePresence(payload.sessionId);
          presence.sockets.add(ws);

          await setSessionState(payload.sessionId, "HUMAN_ACTIVE");

          broadcast(payload.sessionId, {
            type: "staff_joined",
            sessionId: payload.sessionId,
            state: "HUMAN_ACTIVE",
            aiStopped: true,
          });
          broadcast(payload.sessionId, {
            type: "transferring",
            sessionId: payload.sessionId,
            state: "HUMAN_ACTIVE",
          });

          logInfo("chat_ws_join", { sessionId: payload.sessionId, role: "staff" });
          return;
        }

        if ((messageType === "staff_leave" || messageType === "transfer") && payload.sessionId) {
          await setSessionState(payload.sessionId, "AI_ACTIVE");
          broadcast(payload.sessionId, {
            type: "transfer",
            sessionId: payload.sessionId,
            state: "AI_ACTIVE",
          });
          return;
        }

        if ((messageType === "staff_message" || messageType === "user_message" || messageType === "ai_message") && payload.sessionId && payload.content) {
          const role = messageType === "staff_message" ? "staff" : messageType === "ai_message" ? "ai" : "user";
          await pool.query(
            `insert into chat_messages (id, session_id, role, content)
             values ($1, $2, $3, $4)`,
            [randomUUID(), payload.sessionId, role, payload.content]
          );
          broadcast(payload.sessionId, {
            type: messageType,
            sessionId: payload.sessionId,
            role,
            content: payload.content,
          });
          return;
        }

        if ((messageType === "close_chat" || messageType === "close_session") && payload.sessionId) {
          await pool.query(
            `update chat_sessions set status = 'closed', updated_at = now() where id = $1`,
            [payload.sessionId]
          );
          await attachTranscriptToCrm(payload.sessionId);
          broadcast(payload.sessionId, {
            type: "close_session",
            sessionId: payload.sessionId,
          });
          sessionMap.delete(payload.sessionId);
          return;
        }
      } catch (error) {
        logError("chat_ws_message_failed", {
          message: error instanceof Error ? error.message : String(error),
          sessionId: ws.sessionId ?? null,
        });
        ws.send(JSON.stringify({ type: "error", message: "server_error" }));
      }
    });

    ws.on("close", () => {
      detachSocket(ws);
      logInfo("chat_ws_close", { sessionId: ws.sessionId ?? null, role: ws.role ?? null });
    });
  });


  const idleCleanup = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, presence] of sessionMap.entries()) {
      if (presence.sockets.size === 0 || now - presence.updatedAt > 1000 * 60 * 10) {
        sessionMap.delete(sessionId);
      }
    }
  }, 30000);

  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      const socket = client as SessionSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 15000);

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(idleCleanup);
  });

  return wss;
}
