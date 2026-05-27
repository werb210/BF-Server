// BF_SERVER_BLOCK_v500 -- in-memory SSE pub/sub keyed by user_id
import type { Response } from "express";

interface Subscriber {
  userId: string;
  res: Response;
  closed: boolean;
}

const subscribers = new Set<Subscriber>();

export function subscribe(userId: string, res: Response): () => void {
  const sub: Subscriber = { userId, res, closed: false };
  subscribers.add(sub);
  // SSE preamble
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(`: connected ${new Date().toISOString()}\n\n`);
  // BF_SERVER_BLOCK_v104_SSE_HEARTBEAT_v1
  // Azure App Service drops idle HTTP after ~4 minutes. Send a keep-alive
  // SSE comment every 30s; EventSource clients ignore comment frames.
  const ka = setInterval(() => {
    if (sub.closed) return;
    try { res.write(": keep-alive\n\n"); } catch { /* socket closed */ }
  }, 30_000);
  const teardown = () => {
    if (sub.closed) return;
    sub.closed = true;
    clearInterval(ka);
    subscribers.delete(sub);
    try { res.end(); } catch { /* noop */ }
  };
  res.on("close", teardown);
  res.on("error", teardown);
  return teardown;
}

export function publishToUser(userId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    if (sub.userId !== userId || sub.closed) continue;
    try { sub.res.write(payload); } catch { /* noop */ }
  }
}

export function publishToUsers(userIds: string[], event: string, data: unknown): void {
  for (const uid of userIds) publishToUser(uid, event, data);
}

export function publishBroadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const sub of subscribers) {
    if (sub.closed) continue;
    try { sub.res.write(payload); } catch { /* noop */ }
  }
}

export function subscriberCount(): number {
  return subscribers.size;
}
