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
  filed: number;
  contactId: string | null;
}

export async function fileInboundAttachments(opts: {
  pool: Pool;
  graph: GraphClient;
  base: string; // "/me" or "/users/{mailbox}"
  message: { id?: string; hasAttachments?: boolean; from?: { emailAddress?: { address?: string; name?: string } } };
  silo: string;
  ownerId?: string | null;
}): Promise<FileInboundResult> {
  const { pool, graph, base, message, silo } = opts;
  const ownerId = opts.ownerId ?? null;
  if (!message?.hasAttachments) return { filed: 0, contactId: null };
  const messageId = String(message.id ?? "");
  if (!messageId) return { filed: 0, contactId: null };

  const fromEmail = message?.from?.emailAddress?.address ?? "";
  const fromName = message?.from?.emailAddress?.name ?? "";
  const contactId = await resolveSenderContactId(pool, silo, fromEmail, fromName, ownerId);
  if (!contactId) return { filed: 0, contactId: null };

  const ar = await graph.fetch(
    `${base}/messages/${encodeURIComponent(messageId)}/attachments`
      + `?$select=id,name,contentType,size,isInline,contentBytes`,
  );
  if (!ar.ok) return { filed: 0, contactId };
  const aj: any = await ar.json();
  const atts: any[] = Array.isArray(aj?.value) ? aj.value : [];

  const storage = getStorage();
  let filed = 0;
  for (const att of atts) {
    if (!att || att.isInline === true) continue;
    const bytesB64: string | undefined = att.contentBytes;
    if (!bytesB64) continue; // itemAttachment / reference attachment -> no bytes, skip
    if (Number(att.size ?? 0) > MAX_ATTACHMENT_BYTES) continue;
    const buffer = Buffer.from(bytesB64, "base64");
    if (buffer.length > MAX_ATTACHMENT_BYTES) continue;
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
      await pool.query(
        `INSERT INTO contact_documents
           (contact_id, silo, filename, content_type, size_bytes, blob_name, blob_url, source, source_message_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'email',$8)
         ON CONFLICT (silo, source_message_id, filename) WHERE source_message_id IS NOT NULL DO NOTHING`,
        [contactId, silo, filename, contentType, buffer.length, blobName, url, messageId],
      );
      filed++;
    } catch {
      /* skip individual insert failures */
    }
  }
  return { filed, contactId };
}
