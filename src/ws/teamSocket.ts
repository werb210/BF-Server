// BF_SERVER_BLOCK_v750_TEAM_CHAT — JWT-authed WebSocket gateway for live Team chat.
// Connect:  wss://server.boreal.financial/api/team/ws?token=<url_ticket>
// (BF_SERVER_v789_URL_TICKETS: a ticket from POST /api/auth/url-ticket, not the access JWT)
// Server pushes { type:"message", channel_id, message } and { type:"channel", channel_id }
// to every connected socket of the affected channel's members.
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { authenticateUrlTicket } from "../auth/urlTicket.js";

const sockets = new Map<string, Set<WebSocket>>();
let wss: WebSocketServer | null = null;

export function broadcastToUsers(userIds: string[], payload: unknown): void {
  const data = JSON.stringify(payload);
  for (const uid of new Set(userIds)) {
    const set = sockets.get(uid);
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch { /* ignore */ }
      }
    }
  }
}

// BF_SERVER_TEAM_PREFS_v643 - has this person got the portal open (a live Team socket)?
export function isConnected(userId: string): boolean {
  return (sockets.get(userId)?.size ?? 0) > 0;
}

function register(userId: string, ws: WebSocket): void {
  let set = sockets.get(userId);
  if (!set) { set = new Set(); sockets.set(userId, set); }
  set.add(ws);
  ws.on("close", () => {
    const cur = sockets.get(userId);
    if (!cur) return;
    cur.delete(ws);
    if (cur.size === 0) sockets.delete(userId);
  });
}

export function initTeamWebSocket(server: Server): void {
  if (wss) return;
  wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url ?? "", "http://localhost"); } catch { return; }
    if (url.pathname !== "/api/team/ws") return; // let other upgrade handlers deal with it

    // BF_SERVER_v789_URL_TICKETS - ?token= must be a 60-second URL ticket from
    // POST /api/auth/url-ticket (a full staff JWT in the URL is refused); the
    // ticket's user must still be an active staff account at the ticket's tv.
    const token = url.searchParams.get("token") ?? "";
    void authenticateUrlTicket(token).then(
      (result) => {
        // authenticateUrlTicket admits staff roles only (checkStaffUser).
        const uid = result.ok ? String(result.user.userId ?? "") : "";
        if (!uid || socket.destroyed) { socket.destroy(); return; }
        wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          register(uid, ws);
          try { ws.send(JSON.stringify({ type: "ready" })); } catch { /* ignore */ }
        });
      },
      (err: unknown) => {
        console.warn("[team-ws] auth failed", err instanceof Error ? err.message : String(err));
        socket.destroy();
      },
    );
  });

  const interval = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch { /* ignore */ }
        }
      }
    }
  }, 30000);
  wss.on("close", () => clearInterval(interval));
}
