// BF_SERVER_GRAPH_WEBHOOKS_v1 - Microsoft Graph change-notification subscriptions for
// staff mailboxes so new mail fires an instant in-app + push notification. The inbox
// list still polls; this adds real-time alerts on top. Best-effort throughout.
import crypto from "node:crypto";
import type { Pool } from "pg";
import { getGraphForUser, type GraphClient } from "./graphClient.js";
import { createNotification } from "../notifications/notifications.repo.js";
import { logSentMessage, type SentMessage } from "./sentItemsLog.js"; // BF_SERVER_SENT_ITEMS_v39
// BF_SERVER_SHARED_MAILBOX_NOTIFY_v81
import { isNonPersonUser } from "../notifications/notifications.repo.js";
import { notifyAllStaff } from "../../services/notifications/notifyAllStaff.js";
import { pool as defaultPool } from "../../db.js";

const RESOURCE = "me/mailFolders('inbox')/messages";
// BF_SERVER_SENT_ITEMS_v39
const SENT_RESOURCE = "me/mailFolders('sentitems')/messages";
// Graph caps message subscriptions near ~70h; use 60h and renew early.
const LIFETIME_MS = 60 * 60 * 60 * 1000;
const RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;

function notificationUrl(): string {
  const base = process.env.PUBLIC_BASE_URL || "https://server.boreal.financial";
  return `${base.replace(/\/$/, "")}/api/webhooks/graph`;
}

async function graphJson(graph: GraphClient, path: string, init?: RequestInit): Promise<any> {
  const r = await graph.fetch(path, init);
  if (!r.ok) throw new Error(`graph_${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export async function ensureMailSubscription(pool: Pool, userId: string, resource: string = RESOURCE): Promise<void> {
  try {
    const existing = await pool.query<{ expiration_datetime: string }>(
      `SELECT expiration_datetime FROM graph_mail_subscriptions WHERE user_id = $1 AND resource = $2 ORDER BY expiration_datetime DESC LIMIT 1`,
      [userId, resource]
    );
    const row = existing.rows[0];
    if (row && new Date(row.expiration_datetime).getTime() - Date.now() > RENEW_BEFORE_MS) return;
    const graph = await getGraphForUser(pool, userId);
    if (!graph) return;
    const clientState = crypto.randomBytes(24).toString("hex");
    const expiration = new Date(Date.now() + LIFETIME_MS).toISOString();
    const created = await graphJson(graph, "/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        changeType: "created",
        notificationUrl: notificationUrl(),
        resource,
        expirationDateTime: expiration,
        clientState,
      }),
    });
    const subId: string | undefined = created?.id;
    if (!subId) return;
    await pool.query(
      `INSERT INTO graph_mail_subscriptions (id, user_id, subscription_id, resource, client_state, expiration_datetime, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (subscription_id) DO UPDATE SET expiration_datetime = EXCLUDED.expiration_datetime, updated_at = now()`,
      [userId, subId, resource, clientState, created?.expirationDateTime ?? expiration]
    );
  } catch {
    /* best-effort */
  }
}

export async function renewDueSubscriptions(pool: Pool): Promise<void> {
  const due = await pool.query<{ user_id: string; subscription_id: string }>(
    `SELECT user_id, subscription_id FROM graph_mail_subscriptions WHERE expiration_datetime - now() < interval '12 hours'`
  );
  for (const s of due.rows) {
    try {
      const graph = await getGraphForUser(pool, s.user_id);
      if (!graph) continue;
      const expiration = new Date(Date.now() + LIFETIME_MS).toISOString();
      const r = await graph.fetch(`/subscriptions/${encodeURIComponent(s.subscription_id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime: expiration }),
      });
      if (r.ok) {
        await pool.query(`UPDATE graph_mail_subscriptions SET expiration_datetime = $1, updated_at = now() WHERE subscription_id = $2`, [expiration, s.subscription_id]).catch(() => {});
      } else if (r.status === 404 || r.status === 410) {
        await pool.query(`DELETE FROM graph_mail_subscriptions WHERE subscription_id = $1`, [s.subscription_id]).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  resourceData?: { id?: string };
}

const SENT_SELECT = "id,subject,body,from,toRecipients,ccRecipients,internetMessageHeaders";

async function fetchSentMessage(graph: GraphClient, messageId: string): Promise<SentMessage | null> {
  const r = await graph.fetch(`/me/messages/${encodeURIComponent(messageId)}?$select=${SENT_SELECT}`);
  if (!r.ok) return null;
  const text = await r.text();
  return text ? (JSON.parse(text) as SentMessage) : null;
}

export async function handleGraphNotifications(pool: Pool, values: GraphNotification[]): Promise<void> {
  for (const n of values) {
    try {
      if (!n.subscriptionId) continue;
      const r = await pool.query<{ user_id: string; client_state: string; resource: string }>(
        `SELECT user_id, client_state, resource FROM graph_mail_subscriptions WHERE subscription_id = $1 LIMIT 1`,
        [n.subscriptionId]
      );
      const sub = r.rows[0];
      if (!sub) continue;
      if (n.clientState && sub.client_state && n.clientState !== sub.client_state) continue;
      if (sub.resource === SENT_RESOURCE) {
        const messageId = n.resourceData?.id;
        if (!messageId) continue;
        const graph = await getGraphForUser(pool, sub.user_id);
        if (!graph) continue;
        const message = await fetchSentMessage(graph, messageId);
        if (message) await logSentMessage(pool, sub.user_id, message);
        continue;
      }
      // BF_SERVER_SHARED_MAILBOX_NOTIFY_v81
      // The shared mailboxes (submissions@, accounting@, info@) have their Graph
      // subscriptions registered under the seeded admin accounts, which are not
      // people. Every inbound email therefore raised a notification addressed to a
      // ghost - 18 of them in six hours on one day, all unread by construction.
      // v80 stops those rows being written; on its own that would leave shared
      // mailbox mail notifying nobody at all, which is worse than noisy.
      //
      // A mailbox nobody owns is by definition everybody's, so it fans out to all
      // staff. skipSms is on: shared inboxes receive far too much volume to justify
      // a text message per email, and the in-app notification plus browser push is
      // the right weight for "something landed in a shared inbox".
      if (isNonPersonUser(sub.user_id)) {
        const mailbox = mailboxLabel(sub.resource);
        await notifyAllStaff({
          pool: pool ?? defaultPool,
          silo: "BF",
          skipSms: true,
          notificationType: "email_received",
          title: "New shared inbox email",
          body: mailbox
            ? `New message in the ${mailbox} shared inbox.`
            : "New message in a shared inbox.",
          contextUrl: "/communications",
        }).catch(() => { /* best-effort: never break the webhook */ });
        continue;
      }

      await createNotification({
        notificationId: crypto.randomUUID(),
        userId: sub.user_id,
        applicationId: null,
        type: "email_received",
        title: "New email",
        body: "You have a new message in your inbox.",
        metadata: { source: "graph_subscription" },
      });
    } catch {
      /* best-effort */
    }
  }
}

export async function ensureSubscriptionsForConnectedUsers(pool: Pool): Promise<void> {
  const users = await pool.query<{ id: string }>(`SELECT id FROM users WHERE o365_refresh_token IS NOT NULL`);
  for (const u of users.rows) {
    await ensureMailSubscription(pool, u.id);
    await ensureMailSubscription(pool, u.id, SENT_RESOURCE); // BF_SERVER_SENT_ITEMS_v39
  }
}

// BF_SERVER_SHARED_MAILBOX_NOTIFY_v81
// Graph resources are usually "me/mailFolders('inbox')/messages", which names no
// mailbox. Delegated/shared registrations can carry "users/<upn>/..." instead.
// Return the local part when there is one, else null - a generic message is fine,
// a wrong mailbox name is not.
function mailboxLabel(resource: string | null | undefined): string | null {
  const r = String(resource ?? "");
  const m = r.match(/users\/([^/]+)/i);
  if (!m) return null;
  const upn = decodeURIComponent(m[1] ?? "");
  if (!upn.includes("@")) return null;
  return upn.split("@")[0] ?? null;
}
