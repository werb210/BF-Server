import crypto from "node:crypto";

function key(): Buffer {
  const material = process.env.WATCH_PUSH_ENCRYPTION_KEY || process.env.WATCH_JWT_SECRET ||
    (process.env.JWT_SECRET ? `${process.env.JWT_SECRET}:watch-push` : "");
  if (!material) throw new Error("watch_push_not_configured");
  return crypto.createHash("sha256").update(material).digest();
}

export function encryptWatchPushToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

export function decryptWatchPushToken(value: string): string {
  const packed = Buffer.from(value, "base64");
  if (packed.length < 29) throw new Error("invalid_watch_push_token_ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
}

