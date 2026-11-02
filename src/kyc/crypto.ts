// BF_SERVER_v872_KYC - personal details from the ID (and the applicant's private session link) are stored encrypted with
// the same scheme as the SIN/SSN (src/security/ssnCrypto.ts: pgcrypto pgp_sym_encrypt keyed from JWT_SECRET, or
// AES-256-GCM when pgcrypto is missing). Decrypting needs the database, so it only happens on an Admin/Staff request.
import type { Pool, PoolClient } from "pg";
import { decryptSsnFromRow, encryptSsnForInsert } from "../security/ssnCrypto.js";

type Db = Pool | PoolClient;

export async function encryptJson(db: Db, value: unknown): Promise<Buffer | null> {
  if (value === null || value === undefined) return null;
  return encryptSsnForInsert(db, JSON.stringify(value));
}

export async function decryptJson<T = unknown>(db: Db, buf: Buffer | null | undefined): Promise<T | null> {
  if (!buf) return null;
  const s = await decryptSsnFromRow(db, buf);
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/** "123456789" -> "*****6789": what staff see unless they reveal the full number. */
export function maskNumber(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, "");
  if (!s) return null;
  return s.length <= 4 ? "*".repeat(s.length) : `${"*".repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}
