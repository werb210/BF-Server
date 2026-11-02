// BF_SERVER_v875_API_KEYS (ported from KS-server #35, plan gate removed) - API keys for the public REST API.
//
// A key looks like  bf_live_<32 hex: the key's id>_<43 random base64url characters>.
// The id makes the lookup a primary-key read; the whole key is then checked against the stored HMAC-SHA256 in
// constant time. The key itself is shown to the Admin once and never stored. The HMAC key (pepper) is API_KEY_PEPPER;
// when that is not set the server's JWT_SECRET is used instead, and each key records which one hashed it
// (pepper_source), so setting API_KEY_PEPPER later does not break existing keys.
//
// Boreal additions: a key belongs to one silo (it only reads and writes that silo's records) and carries per-area
// scopes (contacts:read, contacts:write, ...), and its own requests-per-minute limit.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Q } from "../settingsPack/common.js";

export const KEY_PREFIX = "bf_live_";
export const MAX_ACTIVE_KEYS = 25;
export const DEFAULT_RATE_LIMIT = 120;
export const MAX_RATE_LIMIT = 600;

export const API_AREAS = ["contacts", "companies", "applications", "notes", "offers", "lenders"] as const;
export type ApiArea = (typeof API_AREAS)[number];

/** Every scope a key can hold. Areas without write endpoints only have :read. */
export const API_SCOPES = [
  "contacts:read", "contacts:write",
  "companies:read", "companies:write",
  "applications:read", "applications:write",
  "notes:read", "notes:write",
  "offers:read",
  "lenders:read",
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_LABELS: Record<ApiScope, string> = {
  "contacts:read": "Read contacts",
  "contacts:write": "Create and update contacts",
  "companies:read": "Read companies",
  "companies:write": "Create and update companies",
  "applications:read": "Read applications",
  "applications:write": "Move applications between stages",
  "notes:read": "Read application notes",
  "notes:write": "Add application notes",
  "offers:read": "Read lender offers",
  "lenders:read": "Read lenders",
};

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}

/** Any input -> a clean list of known scopes; a :write scope brings its :read (writing needs seeing). */
export function normalizeScopes(raw: unknown): { ok: true; scopes: ApiScope[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.length) return { ok: false, error: "Choose at least one permission for the key." };
  const bad = raw.map(String).filter((s) => !isApiScope(s));
  if (bad.length) return { ok: false, error: `Unknown permission: ${bad.join(", ")}.` };
  const set = new Set<ApiScope>(raw.map(String) as ApiScope[]);
  for (const s of [...set]) {
    if (s.endsWith(":write")) {
      const read = s.replace(/:write$/, ":read");
      if (isApiScope(read)) set.add(read);
    }
  }
  return { ok: true, scopes: API_SCOPES.filter((s) => set.has(s)) };
}

export function hasScope(scopes: readonly string[] | null | undefined, need: ApiScope): boolean {
  return Array.isArray(scopes) && scopes.includes(need);
}

export type PepperSource = "env" | "jwt";

/** The pepper for a source, or null when that source is not set on this server. */
export function pepperFor(source: PepperSource, e: NodeJS.ProcessEnv = process.env): string | null {
  const v = String((source === "env" ? e.API_KEY_PEPPER : e.JWT_SECRET) ?? "").trim();
  return v.length >= 10 ? v : null;
}

/** The pepper new keys are hashed with: API_KEY_PEPPER when set, else JWT_SECRET. Null = keys cannot be made. */
export function currentPepper(e: NodeJS.ProcessEnv = process.env): { source: PepperSource; pepper: string } | null {
  const env = pepperFor("env", e);
  if (env) return { source: "env", pepper: env };
  const jwtSecret = pepperFor("jwt", e);
  return jwtSecret ? { source: "jwt", pepper: jwtSecret } : null;
}

export function hashApiKey(key: string, pepper: string): string {
  return createHmac("sha256", pepper).update(key, "utf8").digest("hex");
}

export function idToHex(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function hexToId(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const KEY_SHAPE = /^bf_live_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** The key's id, or null when the string is not shaped like one of our keys. */
export function parseApiKey(raw: string): { id: string } | null {
  const m = KEY_SHAPE.exec(String(raw ?? "").trim());
  return m ? { id: hexToId(m[1]!) } : null;
}

export type NewKey = { id: string; key: string; key_prefix: string; key_hash: string; pepper_source: PepperSource };

export function generateApiKey(pepper: { source: PepperSource; pepper: string }, id: string = randomUUID()): NewKey {
  const secret = randomBytes(32).toString("base64url");
  const hex = idToHex(id);
  const key = `${KEY_PREFIX}${hex}_${secret}`;
  return { id, key, key_prefix: `${KEY_PREFIX}${hex.slice(0, 8)}`, key_hash: hashApiKey(key, pepper.pepper), pepper_source: pepper.source };
}

export type ApiKeyRow = {
  id: string; name: string; silo: string; scopes: string[]; key_prefix: string; key_hash: string; pepper_source: PepperSource;
  rate_limit_per_minute: number; created_by: string | null; created_at: string | Date; last_used_at: string | Date | null;
  last_used_ip: string | null; revoked_at: string | Date | null;
};

export type PublicApiKey = Omit<ApiKeyRow, "key_hash" | "pepper_source">;

export function publicKey(row: ApiKeyRow): PublicApiKey {
  const { key_hash: _h, pepper_source: _p, ...rest } = row;
  return rest;
}

/** Does the presented key match the stored row? Constant-time compare; a missing pepper never matches. */
export function keyMatches(row: Pick<ApiKeyRow, "key_hash" | "pepper_source">, presented: string, e: NodeJS.ProcessEnv = process.env): boolean {
  const pepper = pepperFor(row.pepper_source === "jwt" ? "jwt" : "env", e);
  if (!pepper) return false;
  const a = Buffer.from(hashApiKey(presented, pepper), "hex");
  const b = Buffer.from(String(row.key_hash ?? ""), "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

const COLS = `id::text AS id, name, silo, scopes, key_prefix, key_hash, pepper_source, rate_limit_per_minute,
  created_by::text AS created_by, created_at, last_used_at, last_used_ip, revoked_at`;

export type Authenticated = { ok: true; key: ApiKeyRow } | { ok: false; reason: "malformed" | "unknown" | "revoked" };

/** Finds and checks the key. */
export async function authenticateApiKey(db: Q, presented: string, e: NodeJS.ProcessEnv = process.env): Promise<Authenticated> {
  const parsed = parseApiKey(presented);
  if (!parsed) return { ok: false, reason: "malformed" };
  const r = await db.query(`SELECT ${COLS} FROM api_keys WHERE id = $1::uuid LIMIT 1`, [parsed.id]);
  const row = r.rows[0] as ApiKeyRow | undefined;
  if (!row || !keyMatches(row, presented.trim(), e)) return { ok: false, reason: "unknown" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  return { ok: true, key: row };
}

/** Records use, at most once a minute per key (so a busy integration is not a write per request). */
export async function touchApiKey(db: Q, id: string, ip: string | null): Promise<void> {
  await db.query(
    `UPDATE api_keys SET last_used_at = now(), last_used_ip = $2
      WHERE id = $1::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id, ip ? ip.slice(0, 64) : null],
  );
}

export async function listApiKeys(db: Q, silo: string): Promise<PublicApiKey[]> {
  const r = await db.query(`SELECT ${COLS} FROM api_keys WHERE silo = $1 ORDER BY revoked_at IS NOT NULL, created_at DESC LIMIT 200`, [silo]);
  return (r.rows as ApiKeyRow[]).map(publicKey);
}

export async function countActiveKeys(db: Q, silo: string): Promise<number> {
  const r = await db.query(`SELECT count(*)::int AS n FROM api_keys WHERE silo = $1 AND revoked_at IS NULL`, [silo]);
  return Number(r.rows[0]?.n ?? 0) || 0;
}

export async function insertApiKey(
  db: Q, k: NewKey, args: { name: string; silo: string; scopes: ApiScope[]; rateLimit: number; by: string | null },
): Promise<PublicApiKey> {
  const r = await db.query(
    `INSERT INTO api_keys (id, name, silo, scopes, key_prefix, key_hash, pepper_source, rate_limit_per_minute, created_by)
     VALUES ($1::uuid, $2, $3, $4::text[], $5, $6, $7, $8, $9::uuid)
     RETURNING ${COLS}`,
    [k.id, args.name, args.silo, args.scopes, k.key_prefix, k.key_hash, k.pepper_source, args.rateLimit, args.by],
  );
  return publicKey(r.rows[0] as ApiKeyRow);
}

export async function updateApiKey(
  db: Q, id: string, silo: string, patch: { name?: string; scopes?: ApiScope[]; rateLimit?: number },
): Promise<PublicApiKey | null> {
  const r = await db.query(
    `UPDATE api_keys SET name = COALESCE($3, name), scopes = COALESCE($4::text[], scopes),
            rate_limit_per_minute = COALESCE($5, rate_limit_per_minute)
      WHERE id = $1::uuid AND silo = $2 AND revoked_at IS NULL
     RETURNING ${COLS}`,
    [id, silo, patch.name ?? null, patch.scopes ?? null, patch.rateLimit ?? null],
  );
  return r.rows[0] ? publicKey(r.rows[0] as ApiKeyRow) : null;
}

export async function revokeApiKey(db: Q, id: string, silo: string, by: string | null): Promise<PublicApiKey | null> {
  const r = await db.query(
    `UPDATE api_keys SET revoked_at = now(), revoked_by = $3::uuid WHERE id = $1::uuid AND silo = $2 AND revoked_at IS NULL
     RETURNING ${COLS}`,
    [id, silo, by],
  );
  return r.rows[0] ? publicKey(r.rows[0] as ApiKeyRow) : null;
}

/** The requests-per-minute limit from a body value (default 120, 1-600). */
export function parseRateLimit(raw: unknown): { ok: true; value: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: DEFAULT_RATE_LIMIT };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RATE_LIMIT) return { ok: false, error: `Requests per minute must be a whole number from 1 to ${MAX_RATE_LIMIT}.` };
  return { ok: true, value: n };
}
