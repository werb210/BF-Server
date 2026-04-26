import crypto from "node:crypto";
import type { Pool, PoolClient } from "pg";

function deriveKey(): Buffer {
  const secret = process.env.JWT_SECRET || "";
  if (secret.length < 10) throw new Error("JWT_SECRET missing (needed for SSN crypto fallback)");
  return crypto.createHash("sha256").update("bf-ssn-v1:" + secret).digest();
}

export function ssnFallbackEncrypt(plain: string): Buffer {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function ssnFallbackDecrypt(buf: Buffer): string {
  const key = deriveKey();
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export async function pgcryptoAvailable(client: Pool | PoolClient): Promise<boolean> {
  try {
    const r = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS exists"
    );
    return !!r.rows[0]?.exists;
  } catch {
    return false;
  }
}

export async function encryptSsnForInsert(client: Pool | PoolClient, plain: string | null): Promise<Buffer | null> {
  if (!plain) return null;
  if (process.env.BF_SSN_ENCRYPTION_FALLBACK === "1") return ssnFallbackEncrypt(plain);
  if (await pgcryptoAvailable(client)) {
    const passphrase = "bf-ssn-v1:" + (process.env.JWT_SECRET || "");
    const r = await client.query<{ encrypted: Buffer }>(
      "SELECT pgp_sym_encrypt($1, $2)::bytea AS encrypted",
      [plain, passphrase]
    );
    return r.rows[0]?.encrypted ?? null;
  }
  return ssnFallbackEncrypt(plain);
}

export async function decryptSsnFromRow(client: Pool | PoolClient, ssnEncrypted: Buffer | null): Promise<string | null> {
  if (!ssnEncrypted) return null;
  if (process.env.BF_SSN_ENCRYPTION_FALLBACK === "1") {
    try {
      return ssnFallbackDecrypt(ssnEncrypted);
    } catch {
      return null;
    }
  }
  if (await pgcryptoAvailable(client)) {
    const r = await client.query<{ pt: string }>(
      "SELECT pgp_sym_decrypt($1, $2) AS pt",
      [ssnEncrypted, "bf-ssn-v1:" + (process.env.JWT_SECRET || "")]
    );
    return r.rows[0]?.pt ?? null;
  }
  try {
    return ssnFallbackDecrypt(ssnEncrypted);
  } catch {
    return null;
  }
}
