// BF_SERVER_v873_LENDER_API - sealing lender connection credentials with AES-256-GCM.
//
// The key is LENDER_CREDENTIALS_ENCRYPTION_KEY: 32 random bytes, written as 64 hex characters or as base64
// (`openssl rand -base64 32`). Without it credentials cannot be saved. Each sealed value is
// "v1." + base64url(iv 12 bytes | auth tag 16 bytes | ciphertext). A wrong key or a tampered value opens as null.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_NAME = "LENDER_CREDENTIALS_ENCRYPTION_KEY" as const;

export class CredentialsKeyError extends Error {
  code = "lender_credentials_key_missing";
  constructor(message = "lender_credentials_key_missing") { super(message); }
}

/** The 32-byte key, or null when it is unset or not 32 bytes. */
export function credentialsKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = String(env[KEY_NAME] ?? "").trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return null;
  const b64 = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return b64.length === 32 ? b64 : null;
}

export function credentialsKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return credentialsKey(env) !== null;
}

export function seal(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = credentialsKey(env);
  if (!key) throw new CredentialsKeyError();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url")}`;
}

/** The plain text, or null when there is no key, the key changed, or the value was altered. */
export function open(sealed: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = credentialsKey(env);
  if (!key || !sealed || !sealed.startsWith("v1.")) return null;
  try {
    const buf = Buffer.from(sealed.slice(3), "base64url");
    if (buf.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
