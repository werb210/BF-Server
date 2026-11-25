// BF_SERVER_CRM_FLOWS_v1 - the outside world for email flows: sending through SendGrid, the collateral PDFs an email can
// carry, and who has replied to the flow's reply-to mailbox (a staff mailbox, or a shared mailbox read by an Admin whose
// Microsoft 365 is connected).
import { pool } from "../db.js";
import { getStorage } from "../lib/storage/index.js";

const SEND_URL = "https://api.sendgrid.com/v3/mail/send";
export const MAX_FLOW_ATTACHMENTS = 3;
export type FlowAttachment = { content: string; filename: string; type: string; disposition: "attachment" };

export function flowSendingConfigured(): boolean {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
}

export async function sendFlowEmail(m: {
  to: string; subject: string; html: string; text: string; fromName: string; fromEmail?: string | null; replyTo?: string | null;
  customArgs: Record<string, string>; attachments?: FlowAttachment[];
}, fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!flowSendingConfigured()) return { ok: false, error: "sendgrid_not_configured" };
  const asm = process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID ? { asm: { group_id: Number(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID) } } : {};
  const fromEmail = String(m.fromEmail ?? "").trim() || String(process.env.SENDGRID_FROM);
  const replyTo = String(m.replyTo ?? "").trim();
  const body = {
    personalizations: [{ to: [{ email: m.to }], custom_args: m.customArgs }],
    from: { email: fromEmail, name: m.fromName },
    ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    subject: m.subject,
    content: [{ type: "text/plain", value: m.text }, { type: "text/html", value: m.html }],
    ...(m.attachments?.length ? { attachments: m.attachments.slice(0, MAX_FLOW_ATTACHMENTS) } : {}),
    tracking_settings: { click_tracking: { enable: true }, open_tracking: { enable: true } },
    ...asm,
  };
  try {
    const r = await fetchImpl(SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 202) return { ok: true, status: 202 };
    return { ok: false, status: r.status, error: (await r.text().catch(() => "")).slice(0, 300) };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

export function cleanAttachmentIds(raw: unknown): string[] {
  const ids = Array.isArray(raw) ? raw.map((v) => String(v ?? "").trim()) : [];
  return Array.from(new Set(ids.filter((v) => /^[0-9a-f-]{36}$/i.test(v)))).slice(0, MAX_FLOW_ATTACHMENTS);
}

/** The collateral PDFs (shared Boreal Financial ones and this business's own) as SendGrid attachments. */
export async function loadFlowAttachments(ids: unknown, silo: string): Promise<FlowAttachment[]> {
  const clean = cleanAttachmentIds(ids);
  if (!clean.length) return [];
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, content_type, blob_name FROM collateral_assets WHERE id::text = ANY($1::text[]) AND silo IN ('BF', $2)`,
    [clean, String(silo ?? "BF").toUpperCase()],
  );
  const out: FlowAttachment[] = [];
  for (const id of clean) {
    const row = rows.find((r: any) => r.id === id);
    if (!row) continue;
    const file = await getStorage().get(row.blob_name);
    if (!file) continue;
    const base = String(row.name ?? "document").replace(/[^\w .()-]+/g, "").trim() || "document";
    out.push({ content: Buffer.from(file.buffer).toString("base64"), filename: /\.pdf$/i.test(base) ? base : `${base}.pdf`, type: row.content_type || "application/pdf", disposition: "attachment" });
  }
  return out;
}

export async function listFlowCollateral(silo: string): Promise<Array<{ id: string; name: string; size_bytes: number | null }>> {
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, size_bytes FROM collateral_assets WHERE silo IN ('BF', $1) ORDER BY name`,
    [String(silo ?? "BF").toUpperCase()],
  );
  return rows;
}

/** Who has emailed a mailbox since a time: a staff member's own mailbox, else a shared mailbox read by a connected Admin. */
export type MailboxReply = { from: string; at: string; auto_reply?: boolean; left?: boolean; referrals?: Array<{ email: string; name: string | null; phone: string | null }> };
export async function mailboxReplies(mailbox: string, since: Date): Promise<{ connected: boolean; replies: MailboxReply[] }> {
  const box = String(mailbox ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(box)) return { connected: false, replies: [] };
  const own = await pool.query<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(email) = $1 AND o365_refresh_token IS NOT NULL LIMIT 1`, [box]);
  const reader = own.rows[0] ?? (await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE o365_refresh_token IS NOT NULL AND upper(coalesce(role, '')) = 'ADMIN' ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  )).rows[0];
  if (!reader) return { connected: false, replies: [] };
  const { getGraphForUser } = await import("../modules/o365/graphClient.js");
  const graph = await getGraphForUser(pool as any, reader.id);
  if (!graph) return { connected: false, replies: [] };
  const base = own.rows[0] ? "/me" : `/users/${encodeURIComponent(box)}`;
  const select = encodeURIComponent("from,receivedDateTime,subject,body");
  const filter = encodeURIComponent(`receivedDateTime gt ${since.toISOString()}`);
  const orderby = encodeURIComponent("receivedDateTime asc");
  // BF_SERVER_REPLIES_ALL_FOLDERS_v1 - every folder (a reply already filed or deleted still counts), and auto-replies are
  // read for "has left" and the colleagues they name.
  const resp = await graph.fetch(`${base}/messages?$select=${select}&$filter=${filter}&$orderby=${orderby}&$top=500`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } });
  if (!resp.ok) throw new Error(`graph_${resp.status}`);
  const data = (await resp.json()) as { value?: Array<{ from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; subject?: string; body?: { content?: string } }> };
  const { parseAutoReply } = await import("../services/email/autoReplyReferrals.js");
  const replies = (data.value ?? [])
    .map((x) => {
      const from = String(x.from?.emailAddress?.address ?? "").trim().toLowerCase();
      const info = parseAutoReply(String(x.subject ?? ""), String(x.body?.content ?? ""), from);
      return { from, at: String(x.receivedDateTime ?? ""), ...(info.autoReply ? { auto_reply: true, left: info.left, referrals: info.referrals } : {}) };
    })
    .filter((x) => x.from && x.from !== box && x.at);
  return { connected: true, replies };
}
