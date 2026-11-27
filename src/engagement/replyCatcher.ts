// BF_SERVER_ENGAGEMENT_v1 - the reply catcher. Every five minutes it reads the inbox of every staff member who connected
// Microsoft 365 and every shared mailbox the portal shows (info@, sales@ ...), and files each new message from outside
// against the marketing outreach it answers: Keystone here, PGI on BI-Server. A reply that lands in the "wrong"
// mailbox (a PGI answer in the BF inbox) is no longer missed. Each message is handled once (crm_reply_catch_seen).
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";
import { claimedTick } from "../workers/claim.js";
import { noteReply } from "./notify.js";

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

export async function catchReplies(pool: Pool, now = new Date()): Promise<{ messages: number; filed: number }> {
  // The first run reads the last 14 days, so replies that came in before the catcher existed (and still have nobody
  // answering them) land on the follow-up queue too.
  const first = !(await pool.query(`SELECT 1 FROM crm_reply_catch_seen LIMIT 1`)).rowCount;
  const since = new Date(now.getTime() - (first ? 14 * 24 * 60 : LOOKBACK_MIN) * 60_000);
  const out = { messages: 0, filed: 0 };
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
  }
  await pool.query(`DELETE FROM crm_reply_catch_seen WHERE seen_at < now() - interval '30 days'`).catch((err) => console.warn("[reply-catcher] seen cleanup failed", { message: (err as Error)?.message }));
  return out;
}

export function startReplyCatcher(pool: Pool): { stop: () => void } {
  const tick = claimedTick("engagement_reply_catcher", async () => {
    const r = await catchReplies(pool);
    if (r.messages) console.info("[reply-catcher] tick", r);
  });
  const h = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 60_000).unref?.();
  return { stop: () => clearInterval(h) };
}
