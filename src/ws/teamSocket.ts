// BF_SERVER_BLOCK_v750_TEAM_CHAT — JWT-authed WebSocket gateway for live Team chat.
// Connect:  wss://server.boreal.financial/api/team/ws?token=<access_jwt>
// Server pushes { type:"message", channel_id, message } and { type:"channel", channel_id }
// to every connected socket of the affected channel's members.
import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { ROLES } from "../auth/roles.js";
import { verifyAccessToken } from "../auth/jwt.js";

const sockets = new Map<string, Set<WebSocket>>();
const STAFF_ROLES = new Set<string>([ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING]);
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

    let userId: string | null = null;
    try {
      const token = url.searchParams.get("token") ?? "";
      const payload = verifyAccessToken(token);
      userId = STAFF_ROLES.has(payload.role) ? payload.sub : null;
    } catch { userId = null; }

    if (!userId) { socket.destroy(); return; }
    const uid = userId;

    wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      register(uid, ws);
      try { ws.send(JSON.stringify({ type: "ready" })); } catch { /* ignore */ }
    });
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
