// BF_SERVER_BLOCK_v496_MESSAGE_ATTACHMENTS_TO_DOCUMENTS
// Files sent in a message (client mini-portal -> staff, or staff -> client) lived
// only inside the message as a data URL, so a bank statement a client sent in chat
// never reached the Documents tab, the lender package or the required-document
// checklist. Save each one as an application document (category "Other", which
// skips OCR; staff re-file it from the Documents tab) and record the document id
// on the attachment so the thread and the document are linked.
import { pool } from "../../db.js";

export type MessageAttachment = { name: string; contentType: string; dataUrl: string; documentId?: string | null };

export function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(String(dataUrl ?? ""));
  if (!m) return null;
  try {
    return m[3] ? Buffer.from(m[4], "base64") : Buffer.from(decodeURIComponent(m[4]), "utf8");
  } catch {
    return null;
  }
}

export async function saveMessageAttachmentsAsDocuments(opts: {
  messageId: string;
  applicationId: string;
  attachments: MessageAttachment[];
  uploadedBy: string;
}): Promise<MessageAttachment[]> {
  const { persistAndEnqueue } = await import("../../routes/documents.js");
  const out: MessageAttachment[] = [];
  for (const a of opts.attachments) {
    const buf = decodeDataUrl(a.dataUrl);
    if (!buf || buf.length === 0) { out.push(a); continue; }
    try {
      const doc = await persistAndEnqueue({
        applicationId: opts.applicationId,
        category: "Other",
        file: { buffer: buf, originalname: a.name || "attachment", mimetype: a.contentType || "application/octet-stream", size: buf.length } as any,
        uploadedBy: opts.uploadedBy,
      });
      out.push({ ...a, documentId: doc.id });
    } catch (err: any) {
      if (err?.name === "DuplicateDocumentError") {
        out.push({ ...a, documentId: err?.existing?.id ?? null }); // already on file - link to it
        continue;
      }
      console.error("[message-attachments] save to documents failed", { applicationId: opts.applicationId, name: a.name, error: err?.message ?? String(err) });
      out.push(a);
    }
  }
  if (out.some((a) => a.documentId)) {
    await pool.query(
      `UPDATE communications_messages SET attachments = $2::jsonb WHERE id = $1`,
      [opts.messageId, JSON.stringify(out)],
    ).catch((err: any) => console.error("[message-attachments] link update failed", { messageId: opts.messageId, error: err?.message ?? String(err) }));
  }
  return out;
}
