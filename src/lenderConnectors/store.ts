// BF_SERVER_v873_LENDER_API - lender connections: reading, saving and the encrypted credentials.
//
// Credentials (broker API keys, portal passwords, private keys, webhook secrets) are one JSON object sealed with
// AES-256-GCM under LENDER_CREDENTIALS_ENCRYPTION_KEY (src/lenderConnectors/crypto.ts). Only the last four
// characters of each are kept readable (secret_hints) so the Connection tab can show which key is saved. A secret is
// never sent to the browser and never written to a log.
import { randomBytes } from "node:crypto";
import { KEY_NAME, credentialsKeyConfigured, open, seal } from "./crypto.js";
import type { Q } from "../settingsPack/common.js";
import type { ConnectorKind } from "./types.js";
import type { StatusMapEntry } from "./mapping.js";

export { KEY_NAME, credentialsKeyConfigured };

export type ConnectionRow = {
  id: string;
  lender_id: string;
  connector: ConnectorKind;
  enabled: boolean;
  submit_by_api: boolean;
  email_fallback: boolean;
  poll_enabled: boolean;
  poll_interval_minutes: number;
  config: Record<string, unknown>;
  secrets_encrypted: string | null;
  secret_hints: Record<string, string>;
  status_map: Record<string, StatusMapEntry>;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_message: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export const CONNECTION_COLS = `c.id::text AS id, c.lender_id::text AS lender_id, c.connector, c.enabled, c.submit_by_api, c.email_fallback,
  c.poll_enabled, c.poll_interval_minutes, c.config, c.secrets_encrypted, c.secret_hints, c.status_map, c.last_test_at,
  c.last_test_ok, c.last_test_message, c.last_sync_at, c.last_error, c.created_at, c.updated_at`;

export function sealSecrets(secrets: Record<string, string>, env: NodeJS.ProcessEnv = process.env): string {
  return seal(JSON.stringify(secrets), env);
}

/** The decrypted credentials, or {} when none are saved or the key changed (the Admin re-enters them). */
export function openSecrets(sealed: string | null | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!sealed || !credentialsKeyConfigured(env)) return {};
  const plain = open(sealed, env);
  if (!plain) return {};
  try {
    const parsed = JSON.parse(plain);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function hintFor(value: string): string {
  const v = String(value ?? "");
  if (v.length <= 4) return "saved";
  return `ends ${v.slice(-4)}`;
}

/** A random secret for the webhook URL (and for HMAC when the lender lets us choose). */
export function newWebhookToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function loadConnectionByLender(db: Q, lenderId: string): Promise<ConnectionRow | null> {
  const r = await db.query(`SELECT ${CONNECTION_COLS} FROM lender_connections c WHERE c.lender_id::text = $1 LIMIT 1`, [lenderId]);
  return ((r.rows ?? [])[0] as ConnectionRow | undefined) ?? null;
}

export async function loadConnectionById(db: Q, id: string): Promise<ConnectionRow | null> {
  const r = await db.query(`SELECT ${CONNECTION_COLS} FROM lender_connections c WHERE c.id::text = $1 LIMIT 1`, [id]);
  return ((r.rows ?? [])[0] as ConnectionRow | undefined) ?? null;
}

/** What the browser may see: everything but the sealed credentials. */
export function publicConnection(row: ConnectionRow) {
  const { secrets_encrypted: _sealed, ...rest } = row;
  void _sealed;
  return { ...rest, secrets_saved: Object.keys(row.secret_hints ?? {}) };
}
