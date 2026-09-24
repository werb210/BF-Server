// BF_SERVER_BLOCK_v456_LENDER_PACKAGE_LINK
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { getStorage } from "../../lib/storage/index.js";

type Attachment = { filename: string; contentType: string; content: Buffer };

export function attachLimitBytes(): number {
  const v = Number(process.env.LENDER_PACKAGE_ATTACH_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 15 * 1024 * 1024;
}

export function linkLifetimeDays(): number {
  const v = Number(process.env.LENDER_PACKAGE_LINK_DAYS);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

export function packageLinkBase(): string {
  return (process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "");
}

export function shouldLinkPackage(sizeBytes: number): boolean {
  return sizeBytes > attachLimitBytes();
}

export function formatMegabytes(sizeBytes: number): string {
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function packageLinkEmail(p: { lenderName: string; applicationId: string; url: string; expiresAt: Date; sizeBytes: number }) {
  const size = formatMegabytes(p.sizeBytes);
  const until = p.expiresAt.toISOString().slice(0, 10);
  const bodyText =
    `Application ${p.applicationId} package for ${p.lenderName}.\n\n` +
    `The package is ${size}, too large to attach, so it is available as a secure download:\n${p.url}\n\n` +
    `The link works until ${until}. Reply to this email if you need it resent.`;
  const bodyHtml =
    `<p>Application ${esc(p.applicationId)} package for ${esc(p.lenderName)}.</p>` +
    `<p>The package is ${esc(size)}, too large to attach, so it is available as a secure download:</p>` +
    `<p><a href="${esc(p.url)}">Download the application package (${esc(size)} zip)</a></p>` +
    `<p>The link works until ${esc(until)}. Reply to this email if you need it resent.</p>`;
  return { bodyText, bodyHtml };
}

export async function createPackageLink(
  pool: Pick<Pool, "query">,
  p: { applicationId: string; lenderId: string; zip: Buffer; filename: string },
): Promise<{ token: string; url: string; expiresAt: Date }> {
  const put = await getStorage().put({
    buffer: p.zip,
    filename: p.filename,
    contentType: "application/zip",
    pathPrefix: `lender-packages/${p.applicationId}`,
  });
  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + linkLifetimeDays() * 86_400_000);
  await pool.query(
    `INSERT INTO lender_package_links (token, application_id, lender_id, blob_name, filename, size_bytes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [token, p.applicationId, p.lenderId, put.blobName, p.filename, p.zip.length, expiresAt],
  );
  return { token, url: `${packageLinkBase()}/api/public/lender-package/${token}`, expiresAt };
}

export type EmailDelivery =
  | { ok: true; mode: "attached" | "link"; bodyText: string; bodyHtml?: string; attachments?: Attachment[] }
  | { ok: false; error: string };

export async function prepareEmailDelivery(
  pool: Pick<Pool, "query">,
  p: { applicationId: string; lenderId: string; lenderName: string; zip: Buffer; filename: string },
): Promise<EmailDelivery> {
  if (!shouldLinkPackage(p.zip.length)) {
    return {
      ok: true,
      mode: "attached",
      bodyText: `Application ${p.applicationId} package attached.`,
      attachments: [{ filename: p.filename, contentType: "application/zip", content: p.zip }],
    };
  }
  try {
    const link = await createPackageLink(pool, p);
    return { ok: true, mode: "link", ...packageLinkEmail({ lenderName: p.lenderName, applicationId: p.applicationId, url: link.url, expiresAt: link.expiresAt, sizeBytes: p.zip.length }) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[dispatch] package link failed", { applicationId: p.applicationId, lender: p.lenderName, message });
    return { ok: false, error: `package_link_failed: ${message}` };
  }
}
