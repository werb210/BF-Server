// BF_CONTACT_DOCUMENTS_v1
// Files inbound email attachments against the matching CRM contact in a given silo. Reused by
// the manual "file to CRM" endpoint and by the inbound poller. Non-inline file attachments
// only; inline images (already embedded in the body) and oversized files are skipped. The DB
// insert dedupes on (silo, source_message_id, filename) so re-running is safe.
import type { Pool } from "pg";
import { getStorage } from "../lib/storage/index.js";
import { createContact } from "./contacts.js";
import type { GraphClient } from "../modules/o365/graphClient.js";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function splitName(displayName: string, email: string): { first: string; last: string } {
  const dn = (displayName || "").trim();
  if (dn) {
    const parts = dn.split(/\s+/).filter(Boolean);
    const first = parts[0] ?? dn;
    const last = parts.length > 1 ? parts.slice(1).join(" ") : "";
    return { first, last };
  }
  const local = ((email.split("@")[0] ?? email) || "").trim();
  return { first: local || "Unknown", last: "" };
}

async function resolveSenderContactId(
  pool: Pool,
  silo: string,
  email: string,
  displayName: string,
  ownerId: string | null,
): Promise<string | null> {
  const trimmed = (email || "").trim();
  if (!trimmed) return null;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`,
    [silo, trimmed],
  );
  if (rows[0]) return rows[0].id;
  const { first, last } = splitName(displayName, trimmed);
  const row = await createContact(pool, {
    first_name: first,
    last_name: last,
    email: trimmed,
    silo,
    owner_id: ownerId,
  });
  return row.id;
}

export interface FileInboundResult {
  // BF_SERVER_FILE_TO_CRM_TRUTH_v1 - filed:0 alone cannot tell staff whether the email had
  // no attachments, whether the sender matched no contact, or whether everything was
  // already filed. The portal was reporting all three as "No attachments on this email",
  // which is simply false when the email plainly has three PDFs attached.
  filed: number;
  duplicates?: number;
  contactId: string | null;
  reason?: "no_attachments" | "no_message_id" | "no_contact" | "graph_error" | "all_duplicates";
}

export async function fileInboundAttachments(opts: {
  pool: Pool;
  graph: GraphClient;
  base: string; // "/me" or "/users/{mailbox}"
  message: { id?: string; hasAttachments?: boolean; from?: { emailAddress?: { address?: string; name?: string } } };
  silo: string;
  ownerId?: string | null;
  attachmentId?: string | null; // BF_SERVER_INBOX_FILE_ONE_TO_CRM_v1: file just this attachment
}): Promise<FileInboundResult> {
  const { pool, graph, base, message, silo } = opts;
  const ownerId = opts.ownerId ?? null;
  const onlyAttachmentId = opts.attachmentId ?? null; // BF_SERVER_INBOX_FILE_ONE_TO_CRM_v1
  if (!message?.hasAttachments) return { filed: 0, contactId: null, reason: "no_attachments" };
  const messageId = String(message.id ?? "");
  if (!messageId) return { filed: 0, contactId: null, reason: "no_message_id" };

  const fromEmail = message?.from?.emailAddress?.address ?? "";
  const fromName = message?.from?.emailAddress?.name ?? "";
  const contactId = await resolveSenderContactId(pool, silo, fromEmail, fromName, ownerId);
  if (!contactId) return { filed: 0, contactId: null, reason: "no_contact" };

  // BF_SERVER_INBOX_ATTACHMENT_BYTES_v1
  // This used to $select contentBytes. contentBytes belongs to the fileAttachment DERIVED
  // type, not the base attachment type, so Graph silently OMITS it from a $select on the
  // collection - every attachment then hit the `if (!bytesB64) continue` below and
  // "Save to CRM" filed ZERO documents while reporting success. Fetch the full objects.
  const ar = await graph.fetch(
    `${base}/messages/${encodeURIComponent(messageId)}/attachments`,
  );
  if (!ar.ok) {
    console.error("[file-to-crm] attachments fetch failed", { status: ar.status, messageId });
    return { filed: 0, contactId, reason: "graph_error" };
  }
  const aj: any = await ar.json();
  const atts: any[] = Array.isArray(aj?.value) ? aj.value : [];
  console.log("[file-to-crm] attachments found", { messageId, count: atts.length });

  const storage = getStorage();
  let filed = 0;
  let duplicates = 0;
  let inlineSkipped = 0;
  for (const att of atts) {
    if (!att) continue;
    if (att.isInline === true) { inlineSkipped++; continue; }
    if (onlyAttachmentId && String(att.id ?? "") !== onlyAttachmentId) continue; // BF_SERVER_INBOX_FILE_ONE_TO_CRM_v1
    // BF_SERVER_INBOX_ATTACHMENT_BYTES_v1 - if the collection did not carry the bytes
    // (large attachments, or Graph simply omitting them), fetch the single attachment by
    // id, which always returns the full fileAttachment including contentBytes.
    let bytesB64: string | undefined = att.contentBytes;
    if (!bytesB64 && att.id) {
      const one = await graph.fetch(
        `${base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(String(att.id))}`,
      );
      if (one.ok) {
        const oj: any = await one.json();
        bytesB64 = oj?.contentBytes;
      }
    }
    if (!bytesB64) {
      // itemAttachment / reference attachment -> genuinely has no bytes. Say so, loudly:
      // a silent `continue` here is exactly what made this bug invisible.
      console.error("[file-to-crm] attachment has no bytes, skipping", {
        messageId, name: att.name, odataType: att["@odata.type"],
      });
      continue;
    }
    if (Number(att.size ?? 0) > MAX_ATTACHMENT_BYTES) {
      console.error("[file-to-crm] attachment too large, skipping", { name: att.name, size: att.size });
      continue;
    }
    const buffer = Buffer.from(bytesB64, "base64");
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      console.error("[file-to-crm] attachment too large after decode, skipping", { name: att.name });
      continue;
    }
    const filename = String(att.name ?? "attachment");
    const contentType = String(att.contentType ?? "application/octet-stream");

    let blobName = "";
    let url: string | null = null;
    try {
      const put = await storage.put({
        buffer,
        filename,
        contentType,
        pathPrefix: `contact-docs/${silo.toLowerCase()}/${contactId}`,
      });
      blobName = put.blobName;
      url = put.url ?? null;
    } catch {
      continue; // blob upload failed -> skip this attachment
    }

    try {
      const ins = await pool.query(
        `INSERT INTO contact_documents
           (contact_id, silo, filename, content_type, size_bytes, blob_name, blob_url, source, source_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'email',$8)
         ON CONFLICT (silo, source_message_id, filename) WHERE source_message_id IS NOT NULL DO NOTHING`,
        [contactId, silo, filename, contentType, buffer.length, blobName, url, messageId],
      );
      // BF_SERVER_FILE_TO_CRM_TRUTH_v1 - ON CONFLICT DO NOTHING does not throw, so the old
      // `filed++` counted duplicates as newly-filed. rowCount tells us which actually
      // inserted, so staff can be told "already in CRM" instead of a bare zero.
      if ((ins.rowCount ?? 0) > 0) filed++; else duplicates++;
    } catch {
      /* skip individual insert failures */
    }
  }
  console.log("[file-to-crm] done", { messageId, contactId, filed, duplicates, inlineSkipped });
  return { filed, duplicates, contactId, reason: filed === 0 && duplicates > 0 ? "all_duplicates" : undefined };
}
