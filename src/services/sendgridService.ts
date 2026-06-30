// BF_SERVER_SENDGRID_SERVICE_v1 - bulk marketing email via SendGrid v3.
// Env-gated (SENDGRID_API_KEY + SENDGRID_FROM). Server-side merge of {{field}}
// tokens; per-recipient custom_args.contact_id so the Event Webhook can map
// delivered/open/click/bounce/unsubscribe back to the contact timeline.
const SEND_URL = "https://api.sendgrid.com/v3/mail/send";

export function sendgridConfigured(): boolean {
  return Boolean(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM);
}

export function mergeFields(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, k) => (vars[String(k).toLowerCase()] ?? ""));
}

export async function sendOne(opts: { to: string; subject: string; html: string; contactId?: string | null; customArgs?: Record<string, string> }): Promise<{ ok: boolean; status: number; error?: string }> {
  const asm = process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID ? { asm: { group_id: Number(process.env.SENDGRID_UNSUBSCRIBE_GROUP_ID) } } : {};
  const body = {
    personalizations: [{ to: [{ email: opts.to }], ...((opts.contactId || opts.customArgs) ? { custom_args: { ...(opts.contactId ? { contact_id: String(opts.contactId) } : {}), ...(opts.customArgs ?? {}) } } : {}) }],
    from: { email: String(process.env.SENDGRID_FROM), name: process.env.SENDGRID_FROM_NAME || "Boreal Financial" },
    ...(process.env.SENDGRID_REPLY_TO ? { reply_to: { email: String(process.env.SENDGRID_REPLY_TO) } } : {}),
    subject: opts.subject,
    content: [{ type: "text/html", value: opts.html }],
    tracking_settings: { click_tracking: { enable: true }, open_tracking: { enable: true } },
    ...asm,
  };
  const resp = await fetch(SEND_URL, { method: "POST", headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (resp.status === 202) return { ok: true, status: 202 };
  const text = await resp.text().catch(() => "");
  return { ok: false, status: resp.status, error: text.slice(0, 200) };
}
