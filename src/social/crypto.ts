// BF_SERVER_v937_SOCIAL_POSTING - social tokens are stored encrypted (AES-256-GCM) with SOCIAL_TOKEN_ENCRYPTION_KEY.
import crypto from "node:crypto";

const PREFIX = "v1:";
function key(): Buffer {
  const secret = String(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (secret.length < 32) throw new Error("SOCIAL_TOKEN_ENCRYPTION_KEY is not set (32+ characters)");
  return crypto.createHash("sha256").update("social-token-v1:" + secret).digest();
}
export function socialCryptoReady(): boolean { return String(process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ?? "").trim().length >= 32; }
export function seal(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function open(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith(PREFIX)) throw new Error("unknown token format");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
