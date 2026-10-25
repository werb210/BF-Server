// BF_SERVER_v852_CALC_QBO - QuickBooks tokens are stored encrypted (AES-256-GCM). The key is derived from
// QBO_TOKEN_ENCRYPTION_KEY; a token encrypted with one key cannot be read with another (decrypt throws), so changing
// the key means connecting QuickBooks again.
import crypto from "node:crypto";
import { QBO_MIN_KEY_LENGTH } from "./qboConfig.js";

const PREFIX = "v1:";

function key(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = (env.QBO_TOKEN_ENCRYPTION_KEY ?? "").trim();
  if (secret.length < QBO_MIN_KEY_LENGTH) throw new Error("QBO_TOKEN_ENCRYPTION_KEY is not set");
  return crypto.createHash("sha256").update("bf-qbo-token-v1:" + secret).digest();
}

export function encryptToken(plain: string, env?: Record<string, string | undefined>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(env), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptToken(stored: string, env?: Record<string, string | undefined>): string {
  if (!stored.startsWith(PREFIX)) throw new Error("unknown token format");
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(env), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
