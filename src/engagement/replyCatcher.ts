// BF_SERVER_ENGAGEMENT_v1 - the reply catcher. Every five minutes it reads the inbox of every staff member who connected
// Microsoft 365 and every shared mailbox the portal shows (info@, sales@ ...), and files each new message from outside
// against the marketing outreach it answers: Keystone here, PGI on BI-Server. A reply that lands in the "wrong"
// mailbox (a PGI answer in the BF inbox) is no longer missed. Each message is handled once (crm_reply_catch_seen).
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { claimedTick } from "../workers/claim.js";
import { noteReply, noteStaffResponse } from "./notify.js";

const TICK_MS = 5 * 60_000;
const LOOKBACK_MIN = 30;
const INTERNAL = /@(boreal\.financial|boreal\.insure|keystonecrm\.online)$/i;
const NOREPLY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@/i;

type Msg = { id?: string; internetMessageId?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; subject?: string; body?: { content?: string } };

export function isOutsideSender(email: string): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  return e.includes("@") && !INTERNAL.test(e) && !NOREPLY.test(e);
}

async function readBox(graph: { fetch: (p: string, init?: any) => Promise<Response> }, base: string, since: Date, first = false): Promise<Msg[]> {
  const select = encodeURIComponent("id,internetMessageId,from,receivedDateTime,subject,body");
  const filter = encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`);
  const r = await graph.fetch(`${base}/mailFolders/inbox/messages?$select=${select}&$filter=${filter}&$top=${first ? 500 : 100}`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } });
  if (!r.ok) return [];
  const j = (await r.json()) as { value?: Msg[] };
  return j.value ?? [];
}

type SentMsg = { id?: string; internetMessageId?: string; sentDateTime?: string; subject?: string; toRecipients?: Array<{ emailAddress?: { address?: string } }>; ccRecipients?: Array<{ emailAddress?: { address?: string } }> };
async function readSent(graph: { fetch: (p: string, init?: any) => Promise<Response> }, base: string, since: Date): Promise<SentMsg[]> {
  const select = encodeURIComponent("id,internetMessageId,sentDateTime,subject,toRecipients,ccRecipients");
  const filter = encodeURIComponent(`sentDateTime ge ${since.toISOString()}`);
  const r = await graph.fetch(`${base}/mailFolders/sentitems/messages?$select=${select}&$filter=${filter}&$top=200`);
  if (!r.ok) return [];
  const j = (await r.json()) as { value?: SentMsg[] };
  return j.value ?? [];
}
/** Outside people a sent message went to (internal and no-reply addresses left out). */
export function sentTo(m: SentMsg): string[] {
  const all = [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map((x) => String(x?.emailAddress?.address ?? "").trim().toLowerCase());
  return [...new Set(all.filter(isOutsideSender))];
}

export async function catchReplies(pool: Pool, now = new Date()): Promise<{ messages: number; filed: number; responded: number }> {
  // The first run reads the last 14 days, so replies that came in before the catcher existed (and still have nobody
  // answering them) land on the follow-up queue too.
  const first = !(await pool.query(`SELECT 1 FROM crm_reply_catch_seen LIMIT 1`)).rowCount;
  const since = new Date(now.getTime() - (first ? 14 * 24 * 60 : LOOKBACK_MIN) * 60_000);
  // The first Sent Items read also looks back 14 days, so answers staff already sent count.
  const firstSent = !(await pool.query(`SELECT 1 FROM crm_reply_catch_seen WHERE message_id LIKE 'sent:%' LIMIT 1`)).rowCount;
  const sinceSent = new Date(now.getTime() - (firstSent ? 14 * 24 * 60 : LOOKBACK_MIN) * 60_000);
  const out = { messages: 0, filed: 0, responded: 0 };
  const users = (await pool.query<{ id: string; box: string | null; admin: boolean }>(
    `SELECT id::text AS id, lower(coalesce(o365_user_email, email)) AS box, upper(coalesce(role, '')) = 'ADMIN' AS admin
       FROM users WHERE o365_refresh_token IS NOT NULL AND coalesce(active, true)`)).rows;
  const shared = (await pool.query<{ address: string }>(`SELECT DISTINCT lower(address) AS address FROM shared_mailbox_settings`).catch((err) => { console.warn("[reply-catcher] shared mailboxes read failed", { message: (err as Error)?.message }); return { rows: [] as Array<{ address: string }> }; })).rows;
  const boxes: Array<{ reader: string; base: string; box: string }> = users.map((u) => ({ reader: u.id, base: "/me", box: u.box ?? "" }));
  const admin = users.find((u) => u.admin);
  if (admin) for (const s of shared) if (!users.some((u) => u.box === s.address)) boxes.push({ reader: admin.id, base: `/users/${encodeURIComponent(s.address)}`, box: s.address });
  const { parseAutoReply } = await import("../services/email/autoReplyReferrals.js");
  for (const b of boxes) {
    let msgs: Msg[] = [];
    try {
      const graph = await getGraphForUser(pool as any, b.reader);
      if (!graph) continue;
      msgs = await readBox(graph as any, b.base, since, first);
    } catch (err) {
      console.warn("[reply-catcher] mailbox read failed", { box: b.box, message: (err as Error)?.message });
      continue;
    }
    for (const m of msgs) {
      const from = String(m.from?.emailAddress?.address ?? "").trim().toLowerCase();
      const key = String(m.internetMessageId || m.id || "");
      if (!key || !isOutsideSender(from) || !m.receivedDateTime) continue;
      const fresh = await pool.query(`INSERT INTO crm_reply_catch_seen (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [key.slice(0, 500)]);
      if (!fresh.rowCount) continue;
      out.messages += 1;
      // An out-of-office is not an answer (the flows deal with "has left" and the colleagues it names).
      if (parseAutoReply(String(m.subject ?? ""), String(m.body?.content ?? ""), from).autoReply) continue;
      const r = await noteReply(pool, { email: from, at: new Date(m.receivedDateTime), subject: m.subject ?? null, body: m.body?.content ?? null, mailbox: b.box || null });
      if (r.local || r.bi) out.filed += 1;
    }
    // BF_SERVER_SENT_ITEMS_RESPONDED_v1 - and what this mailbox sent: answering a PGI contact moves them on the pipeline.
    let sent: SentMsg[] = [];
    try {
      const graph = await getGraphForUser(pool as any, b.reader);
      if (graph) sent = await readSent(graph as any, b.base, sinceSent);
    } catch (err) {
      console.warn("[reply-catcher] sent items read failed", { box: b.box, message: (err as Error)?.message });
    }
    for (const m of sent) {
      const key = String(m.internetMessageId || m.id || "");
      if (!key || !m.sentDateTime) continue;
      const fresh = await pool.query(`INSERT INTO crm_reply_catch_seen (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1`, [`sent:${key}`.slice(0, 500)]);
      if (!fresh.rowCount) continue;
      for (const to of sentTo(m)) if (await noteStaffResponse({ email: to, at: new Date(m.sentDateTime), mailbox: b.box || null, subject: m.subject ?? null })) out.responded += 1;
    }
  }
  await pool.query(`DELETE FROM crm_reply_catch_seen WHERE seen_at < now() - interval '30 days'`).catch((err) => console.warn("[reply-catcher] seen cleanup failed", { message: (err as Error)?.message }));
  return out;
}

export function startReplyCatcher(pool: Pool): { stop: () => void } {
  const tick = claimedTick("engagement_reply_catcher", async () => {
    const r = await catchReplies(pool);
    if (r.messages || r.responded) console.info("[reply-catcher] tick", r);
  });
  const h = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  return { stop: () => clearInterval(h) };
}
