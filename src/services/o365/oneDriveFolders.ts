// BF_SERVER_ONEDRIVE_ATTACHMENTS_v647
// Where email attachments go in OneDrive:
//   Email Attachments / <sender name> / <YYYY-MM-DD> - <subject>
// OneDrive refuses some characters and trailing dots/spaces, so every part is cleaned.

const BAD = /["*:<>?/|#%\u005C]/g; // \u005C is the backslash

export function cleanPart(value: unknown, fallback: string, max = 80): string {
  const s = String(value ?? "")
    .replace(BAD, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, max)
    .trim()
    .replace(/[. ]+$/g, "");
  return s || fallback;
}

export function attachmentFolder(input: { senderName?: string | null; senderAddress?: string | null; receivedAt?: string | null; subject?: string | null }): string {
  const sender = cleanPart(input.senderName || input.senderAddress, "Unknown sender", 60);
  const d = input.receivedAt ? new Date(input.receivedAt) : null;
  const day = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "undated";
  const subject = cleanPart(input.subject, "No subject", 80);
  return ["Email Attachments", sender, day + " - " + subject].join("/");
}

/** Graph path segment for a OneDrive item: each part URL-encoded, slashes kept. */
export function drivePath(folder: string, fileName?: string): string {
  const parts = folder.split("/").concat(fileName ? [cleanPart(fileName, "attachment", 150)] : []);
  return parts.map((p) => encodeURIComponent(p)).join("/");
}
