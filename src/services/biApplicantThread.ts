// BF_SERVER_BLOCK_v610_BI_THREAD - the BI applicant's in-app thread, addressed by phone.
// BI-Server relays the signed-in applicant (x-applicant-phone) over the service bridge.
// Messages live with every other staff conversation: communications_messages, silo 'BI',
// keyed on the applicant's BI contact (matched on the last ten digits, created if missing).
type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export type BiAttachment = { name: string; contentType: string; dataUrl: string };
const digits10 = (phone: string) => String(phone ?? "").replace(/\D/g, "").slice(-10);

export function cleanAttachments(raw: unknown): BiAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a: any) => a && typeof a.name === "string" && typeof a.dataUrl === "string" && a.dataUrl.startsWith("data:"))
    .slice(0, 3)
    .map((a: any) => ({
      name: String(a.name).slice(0, 200),
      contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 80) : "application/octet-stream",
      dataUrl: String(a.dataUrl).slice(0, 3_500_000),
    }));
}

export async function biContactForPhone(query: Query, phone: string): Promise<string | null> {
  const d = digits10(phone);
  if (d.length < 10) return null;
  const found = await query(
    `SELECT id::text AS id FROM contacts
      WHERE silo = 'BI' AND phone IS NOT NULL AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
      ORDER BY created_at ASC LIMIT 1`, [d]);
  if (found.rows[0]?.id) return found.rows[0].id;
  const ins = await query(`INSERT INTO contacts (name, phone, silo) VALUES ($1, $1, 'BI') RETURNING id::text AS id`, [phone]);
  return ins.rows[0]?.id ?? null;
}

function toClient(r: any) {
  return {
    id: r.id,
    body: r.body ?? "",
    createdAt: r.created_at,
    sender: r.direction === "inbound" ? "applicant" : "staff",
    staffName: r.direction === "inbound" ? null : r.staff_name ?? null,
    attachments: (Array.isArray(r.attachments) ? r.attachments : []).map((a: any) => ({ name: String(a?.name ?? "file"), url: a?.dataUrl ?? a?.url ?? undefined })),
  };
}

async function unread(query: Query, contactId: string): Promise<number> {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM communications_messages
      WHERE contact_id = $1::uuid AND silo = 'BI' AND type = 'message' AND direction = 'outbound' AND read_at IS NULL`, [contactId]);
  return Number(r.rows[0]?.n ?? 0);
}

export async function biThreadForPhone(query: Query, phone: string) {
  const contactId = await biContactForPhone(query, phone);
  if (!contactId) return null;
  const rows = await query(
    `SELECT id::text AS id, body, direction, staff_name, attachments, created_at FROM communications_messages
      WHERE contact_id = $1::uuid AND silo = 'BI' AND type = 'message' ORDER BY created_at DESC LIMIT 200`, [contactId]);
  return { messages: rows.rows.reverse().map(toClient), unreadCount: await unread(query, contactId) };
}

export async function biUnreadForPhone(query: Query, phone: string): Promise<number> {
  const contactId = await biContactForPhone(query, phone);
  return contactId ? unread(query, contactId) : 0;
}

export async function biMarkReadForPhone(query: Query, phone: string): Promise<number> {
  const contactId = await biContactForPhone(query, phone);
  if (!contactId) return 0;
  const r = await query(
    `UPDATE communications_messages SET read_at = now()
      WHERE contact_id = $1::uuid AND silo = 'BI' AND type = 'message' AND direction = 'outbound' AND read_at IS NULL RETURNING id`, [contactId]);
  return r.rows.length;
}

export async function biSendForPhone(query: Query, phone: string, body: string, attachments: BiAttachment[]) {
  const contactId = await biContactForPhone(query, phone);
  if (!contactId) return null;
  const r = await query(
    `INSERT INTO communications_messages (id, type, direction, status, contact_id, silo, body, phone_number, from_number, attachments, created_at)
     VALUES (gen_random_uuid(), 'message', 'inbound', 'received', $1::uuid, 'BI', $2, $3, $3,
             CASE WHEN $4::text = '[]' THEN NULL ELSE $4::jsonb END, now())
     RETURNING id::text AS id, body, direction, staff_name, attachments, created_at`,
    [contactId, body, phone, JSON.stringify(attachments)]);
  return toClient(r.rows[0]);
}
