// BF_SERVER_v875_WEBHOOKS (ported from KS-server #39) - sending what the outbox holds: claim due deliveries, sign,
// POST, retry with backoff, give up, disable an endpoint that keeps failing and tell the silo's Admins.
//
// Retries: attempt n failed -> next attempt after 1, 2, 4, 8 ... minutes (capped at 6 hours, +-20% jitter); after 10
// attempts the delivery is "dead". An endpoint is disabled (and every active Admin gets a notification) after 5 dead
// deliveries in a row with no success in between, at once when the receiver answers 410 Gone (Zapier's answer once a
// Zap is turned off), or when its host now resolves to a private address. Any 2xx resets the count.
//
// Batching (Boreal addition): an endpoint with batch_size > 1 gets the deliveries that are due together - up to
// batch_size of them - as one signed JSON array. Each delivery in the batch keeps its own attempt count and log row,
// and the batch's answer is recorded on every one of them.
import { randomUUID } from "node:crypto";
import https from "node:https";
import type { Q } from "../settingsPack/common.js";
import { buildBatchBody, buildBody, type DeliveryRow } from "./events.js";
import { signatureHeaders } from "./signing.js";
import { BlockedAddressError, checkUrlShape, safeLookup, type Resolver, systemResolver } from "./ssrf.js";

export const RETRY = {
  maxAttempts: 10,
  baseMs: 60_000,
  maxMs: 6 * 60 * 60_000,
  timeoutMs: 10_000,
  /** Dead deliveries in a row (no success between) that disable an endpoint. */
  disableAfterDead: 5,
  /** A delivery stuck in "sending" this long (a worker died mid-send) is picked up again. */
  staleClaimMs: 10 * 60_000,
  keepDays: 30,
  responseChars: 2000,
};
export const CLAIM_LIMIT = 100;

/** Delay before the next attempt, after `attempts` failed attempts (1 = the first failed). */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempts));
  const raw = Math.min(RETRY.maxMs, RETRY.baseMs * 2 ** (n - 1));
  const jitter = 1 + (rand() * 0.4 - 0.2);
  return Math.max(1000, Math.round(Math.min(RETRY.maxMs, raw * jitter)));
}

export type TransportRequest = { url: string; headers: Record<string, string>; body: string; timeoutMs: number };
export type TransportResponse = { status: number; body: string };
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** POST over HTTPS. The socket's DNS lookup refuses private targets (SSRF re-check at connect time). No redirects. */
export function httpsTransport(resolve: Resolver = systemResolver): Transport {
  return (req) => new Promise<TransportResponse>((resolveP, reject) => {
    const shape = checkUrlShape(req.url);
    if (!shape.ok) { reject(new BlockedAddressError(req.url, shape.error)); return; }
    const r = https.request(shape.url, {
      method: "POST",
      headers: { ...req.headers, "Content-Length": Buffer.byteLength(req.body).toString() },
      lookup: safeLookup(resolve) as any,
      agent: false,
      timeout: req.timeoutMs,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { if (text.length < RETRY.responseChars) text += chunk; });
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, body: text.slice(0, RETRY.responseChars) }));
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(Object.assign(new Error(`no response within ${Math.round(req.timeoutMs / 1000)}s`), { code: "ETIMEDOUT" })));
    r.on("error", reject);
    r.end(req.body);
  });
}

export type ClaimedDelivery = DeliveryRow & {
  id: string; endpoint_id: string; attempts: number; url: string; endpoint_status: string; secret: string | null;
  batch_size?: number | null; endpoint_silo?: string | null;
};

/** Claims up to `limit` due deliveries (skip-locked, so instances never share one). */
export async function claimDue(db: Q, limit = CLAIM_LIMIT): Promise<ClaimedDelivery[]> {
  const r = await db.query(
    `WITH due AS (
       SELECT d.id FROM webhook_deliveries d
        WHERE (d.status = 'pending' AND d.next_attempt_at <= now())
           OR (d.status = 'sending' AND d.claimed_at < now() - ($2 || ' milliseconds')::interval)
        ORDER BY d.next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE webhook_deliveries d SET status = 'sending', claimed_at = now()
       FROM due WHERE d.id = due.id
     RETURNING d.id::text AS id, d.event_id::text AS event_id, d.endpoint_id::text AS endpoint_id, d.silo, d.event_type,
               d.object_type, d.occurred_at, d.payload, d.attempts,
               (SELECT e.url FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS url,
               (SELECT e.status FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS endpoint_status,
               (SELECT e.batch_size FROM webhook_endpoints e WHERE e.id = d.endpoint_id) AS batch_size,
               (SELECT s.secret FROM webhook_endpoint_secrets s WHERE s.endpoint_id = d.endpoint_id) AS secret`,
    [limit, String(RETRY.staleClaimMs)],
  );
  return r.rows as ClaimedDelivery[];
}

export type DeliverDeps = { transport: Transport; now?: () => number; rand?: () => number };
export type Outcome = "succeeded" | "retry" | "dead" | "skipped";

function errText(err: unknown): string {
  const e = err as { code?: string; message?: string } | null;
  return [e?.code, e?.message].filter(Boolean).join(": ").slice(0, 500) || "request failed";
}

type SendResult = { status: number; responseText: string; error: string | null; blocked: boolean; ms: number };

async function send(deps: DeliverDeps, url: string, headers: Record<string, string>, body: string): Promise<SendResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  let status = 0;
  let responseText = "";
  let error: string | null = null;
  let blocked = false;
  try {
    const res = await deps.transport({ url, headers, body, timeoutMs: RETRY.timeoutMs });
    status = res.status;
    responseText = res.body ?? "";
  } catch (err) {
    blocked = err instanceof BlockedAddressError || (err as any)?.code === "EWEBHOOK_BLOCKED_ADDRESS";
    error = errText(err);
  }
  return { status, responseText, error, blocked, ms: Math.max(0, now() - started) };
}

/** Records one delivery's outcome after a send (alone or in a batch). Returns what happened to it. */
async function record(db: Q, d: ClaimedDelivery, attempt: number, r: SendResult, deps: DeliverDeps): Promise<Outcome> {
  const now = deps.now ?? Date.now;
  if (r.status >= 200 && r.status < 300) {
    await db.query(
      `UPDATE webhook_deliveries SET status = 'succeeded', attempts = $2, last_attempt_at = now(), delivered_at = now(),
              last_status_code = $3, last_error = NULL, last_duration_ms = $4 WHERE id = $1`,
      [d.id, attempt, r.status, r.ms],
    );
    await db.query(`UPDATE webhook_endpoints SET consecutive_failures = 0, last_success_at = now() WHERE id = $1`, [d.endpoint_id]);
    return "succeeded";
  }
  const why = r.error ?? `HTTP ${r.status}${r.responseText ? `: ${r.responseText.slice(0, 300)}` : ""}`;
  const gone = r.status === 410;
  const dead = gone || r.blocked || attempt >= RETRY.maxAttempts;
  if (!dead) {
    const next = new Date(now() + backoffMs(attempt, deps.rand));
    await db.query(
      `UPDATE webhook_deliveries SET status = 'pending', attempts = $2, last_attempt_at = now(), next_attempt_at = $3,
              last_status_code = $4, last_error = $5, last_duration_ms = $6 WHERE id = $1`,
      [d.id, attempt, next.toISOString(), r.status || null, why, r.ms],
    );
    await db.query(`UPDATE webhook_endpoints SET last_failure_at = now() WHERE id = $1`, [d.endpoint_id]);
    return "retry";
  }
  await db.query(
    `UPDATE webhook_deliveries SET status = 'dead', attempts = $2, last_attempt_at = now(), last_status_code = $3,
            last_error = $4, last_duration_ms = $5 WHERE id = $1`,
    [d.id, attempt, r.status || null, why, r.ms],
  );
  const ep = await db.query(
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, last_failure_at = now() WHERE id = $1
     RETURNING consecutive_failures`,
    [d.endpoint_id],
  );
  const failures = Number(ep.rows[0]?.consecutive_failures ?? 0);
  if (gone) await disableEndpoint(db, d.endpoint_id, d.url, "The receiver answered 410 Gone: it no longer wants these events (a Zap that was turned off answers this).");
  else if (r.blocked) await disableEndpoint(db, d.endpoint_id, d.url, "The address now points at a private or internal network, so nothing more is sent to it.");
  else if (failures >= RETRY.disableAfterDead) await disableEndpoint(db, d.endpoint_id, d.url, `${failures} events in a row could not be delivered after ${RETRY.maxAttempts} attempts each.`);
  return "dead";
}

async function skip(db: Q, d: ClaimedDelivery): Promise<Outcome> {
  await db.query(`UPDATE webhook_deliveries SET status = 'skipped', last_error = $2 WHERE id = $1`,
    [d.id, d.endpoint_status === "active" ? "The endpoint has no signing secret." : `The endpoint is ${d.endpoint_status ?? "deleted"}.`]);
  return "skipped";
}

const sendable = (d: ClaimedDelivery) => d.endpoint_status === "active" && Boolean(d.secret) && Boolean(d.url);

function baseHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", "User-Agent": "Boreal-Webhooks/1.0" };
}

/** Sends one claimed delivery and records the outcome. Never throws for a receiver problem. */
export async function deliverOne(db: Q, d: ClaimedDelivery, deps: DeliverDeps): Promise<Outcome> {
  if (!sendable(d)) return skip(db, d);
  const now = deps.now ?? Date.now;
  const attempt = Number(d.attempts ?? 0) + 1;
  const body = buildBody(d);
  const headers: Record<string, string> = {
    ...baseHeaders(),
    "X-Webhook-Event": d.event_type,
    "X-Webhook-Id": d.event_id,
    "X-Webhook-Delivery": d.id,
    "X-Webhook-Attempt": String(attempt),
    ...signatureHeaders(d.secret!, body, now()),
  };
  return record(db, d, attempt, await send(deps, d.url, headers, body), deps);
}

/** Sends deliveries for ONE endpoint as one JSON array (oldest first) and records the answer on each. */
export async function deliverBatch(db: Q, list: ClaimedDelivery[], deps: DeliverDeps): Promise<Outcome[]> {
  if (list.length === 1) return [await deliverOne(db, list[0]!, deps)];
  const first = list[0]!;
  if (!sendable(first)) return Promise.all(list.map((d) => skip(db, d)));
  const now = deps.now ?? Date.now;
  const attempt = Math.max(...list.map((d) => Number(d.attempts ?? 0))) + 1;
  const body = buildBatchBody(list);
  const headers: Record<string, string> = {
    ...baseHeaders(),
    "X-Webhook-Event": "batch",
    "X-Webhook-Batch-Size": String(list.length),
    "X-Webhook-Delivery": first.id,
    "X-Webhook-Attempt": String(attempt),
    ...signatureHeaders(first.secret!, body, now()),
  };
  const r = await send(deps, first.url, headers, body);
  const out: Outcome[] = [];
  for (const d of list) out.push(await record(db, d, Number(d.attempts ?? 0) + 1, r, deps));
  return out;
}

/** Disables an active endpoint and notifies the active Admins (once: only the call that disables it alerts). */
export async function disableEndpoint(db: Q, endpointId: string, url: string, reason: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE webhook_endpoints SET status = 'disabled', disabled_at = now(), disabled_reason = $2, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING id, silo`,
    [endpointId, reason],
  );
  if (!r.rows.length) return false;
  const admins = await db.query(
    `SELECT id::text AS id FROM users
      WHERE COALESCE(active, true) AND COALESCE(disabled, false) = false AND deleted_at IS NULL AND role = 'Admin'`,
    [],
  );
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw url */ }
  const silo = String(r.rows[0]?.silo ?? "BF");
  for (const a of admins.rows) {
    await db.query(
      `INSERT INTO notifications (id, user_id, type, title, body, metadata, context_url, created_at, read_at)
       VALUES ($1, $2, 'webhook_disabled', 'A webhook was turned off', $3, $4::jsonb, '/settings/webhooks', now(), null)`,
      [randomUUID(), a.id, `${silo} webhook deliveries to ${host} were stopped. ${reason} Fix the receiver, then turn it back on in Settings > Webhooks and resend what was missed.`,
        JSON.stringify({ webhook_endpoint_id: endpointId, silo, reason })],
    );
  }
  console.warn("[webhooks] endpoint disabled", { endpointId, host, silo, reason });
  return true;
}

/** Deliveries older than 30 days are removed (the log shows the last 30 days). */
export async function pruneOld(db: Q): Promise<number> {
  const r = await db.query(`DELETE FROM webhook_deliveries WHERE created_at < now() - ($1 || ' days')::interval`, [String(RETRY.keepDays)]);
  return r.rowCount ?? 0;
}

/** Splits one endpoint's claimed deliveries into the requests to send: batches of batch_size, oldest first. */
export function planRequests(list: ClaimedDelivery[]): ClaimedDelivery[][] {
  const size = Math.min(100, Math.max(1, Math.floor(Number(list[0]?.batch_size ?? 1)) || 1));
  const sorted = [...list].sort((a, b) => new Date(String(a.occurred_at)).getTime() - new Date(String(b.occurred_at)).getTime());
  const out: ClaimedDelivery[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

/** Claims and sends what is due. Returns how many deliveries were attempted. */
export async function runDueDeliveries(db: Q, deps: DeliverDeps, limit = CLAIM_LIMIT): Promise<number> {
  const claimed = await claimDue(db, limit);
  // Different endpoints in parallel; one endpoint's deliveries in order.
  const byEndpoint = new Map<string, ClaimedDelivery[]>();
  for (const d of claimed) byEndpoint.set(d.endpoint_id, [...(byEndpoint.get(d.endpoint_id) ?? []), d]);
  await Promise.all([...byEndpoint.values()].map(async (list) => {
    for (const group of planRequests(list)) {
      try { await deliverBatch(db, group, deps); }
      catch (err) {
        console.error("[webhooks] delivery bookkeeping failed", { ids: group.map((d) => d.id), message: (err as Error)?.message });
        await db.query(
          `UPDATE webhook_deliveries SET status = 'pending', next_attempt_at = now() + interval '1 minute' WHERE id = ANY($1::uuid[]) AND status = 'sending'`,
          [group.map((d) => d.id)],
        ).catch((e: unknown) => console.error("[webhooks] could not release deliveries", { message: (e as Error)?.message }));
      }
    }
  }));
  return claimed.length;
}
