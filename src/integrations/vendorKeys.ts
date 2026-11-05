// BF_SERVER_v898_YOUR_SERVICES - Boreal's own keys for paid verification services, pasted by an Admin in
// Settings > Your services instead of Azure. Stored encrypted (AES-256-GCM) in vendor_keys, never shown again (only
// "set" and the last 4 characters), and put into the process environment on every instance (loaded at start, every
// minute and right after a save), so the existing ID-check, IP and registry code reads them unchanged. A value set in
// Azure always wins over one saved here.
//
// Sealing key: VENDOR_KEYS_ENCRYPTION_KEY, else LENDER_CREDENTIALS_ENCRYPTION_KEY, else one derived from JWT_SECRET
// (the same on both slots). If that key changes, saved values can no longer be read and must be entered again.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type VendorKeyDef = { key: string; label: string; service: string; secret: boolean; hint?: string };

export const VENDOR_KEYS: readonly VendorKeyDef[] = [
  { key: "ONFIDO_API_TOKEN", service: "id", label: "Entrust IDV (Onfido) API token", secret: true },
  { key: "ONFIDO_WORKFLOW_ID", service: "id", label: "Entrust IDV (Onfido) workflow ID", secret: false },
  { key: "ONFIDO_WEBHOOK_TOKEN", service: "id", label: "Entrust IDV (Onfido) webhook token", secret: true },
  { key: "ONFIDO_REGION", service: "id", label: "Entrust IDV (Onfido) region", secret: false, hint: "ca, us or eu (ca keeps applicant data in Canada)" },
  { key: "IPINFO_TOKEN", service: "ip", label: "ipinfo token", secret: true },
  { key: "CORPORATIONS_CANADA_API_KEY", service: "registry", label: "Corporations Canada API key", secret: true },
];
export const VENDOR_KEY_NAMES: ReadonlySet<string> = new Set(VENDOR_KEYS.map((d) => d.key));

export const VENDOR_SERVICES = [
  { id: "id", name: "ID checks (Entrust Identity Verification, formerly Onfido)", signup: "https://www.entrust.com/products/identity-verification", what: "Applicants photograph their ID and take a selfie; Entrust checks them. Without it, ID checks go to manual review." },
  { id: "ip", name: "IP location and VPN (ipinfo)", signup: "https://ipinfo.io/signup", what: "Adds VPN, proxy and Tor flags. Without it, the free check still gives the country and data-centre networks." },
  { id: "registry", name: "Corporations Canada (federal business registry)", signup: "https://api.ised-isde.canada.ca/", what: "Confirms a federally registered business exists and is active. Without it, the registry check is skipped." },
];

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export function sealingKey(env: NodeJS.ProcessEnv = process.env): { name: string; key: Buffer } | null {
  for (const name of ["VENDOR_KEYS_ENCRYPTION_KEY", "LENDER_CREDENTIALS_ENCRYPTION_KEY"]) {
    const raw = String(env[name] ?? "").trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return { name, key: Buffer.from(raw, "hex") };
    if (raw) { const b = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64"); if (b.length === 32) return { name, key: b }; }
  }
  const jwt = String(env.JWT_SECRET ?? "").trim();
  return jwt ? { name: "JWT_SECRET", key: createHash("sha256").update("vendor-keys:" + jwt, "utf8").digest() } : null;
}

function keyNamed(name: string, env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const k = sealingKey({ ...env, ...(name === "JWT_SECRET" ? { VENDOR_KEYS_ENCRYPTION_KEY: "", LENDER_CREDENTIALS_ENCRYPTION_KEY: "" } : name === "LENDER_CREDENTIALS_ENCRYPTION_KEY" ? { VENDOR_KEYS_ENCRYPTION_KEY: "" } : {}) });
  return k && k.name === name ? k.key : null;
}

export function seal(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url")}`;
}

export function unseal(sealed: string, key: Buffer | null): string | null {
  if (!key || !sealed.startsWith("v1.")) return null;
  try {
    const buf = Buffer.from(sealed.slice(3), "base64url");
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const fromAzure = new Set<string>(VENDOR_KEYS.map((d) => d.key).filter((k) => String(process.env[k] ?? "").trim()));
const setByUs = new Set<string>();
let current: Record<string, string> = {};

/** Reads, decrypts and applies the saved keys. Never throws. */
export async function loadVendorKeys(db: Q): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const r = await db.query(`SELECT key, value_enc, key_name FROM vendor_keys`);
    for (const row of r.rows as Array<{ key: string; value_enc: string; key_name: string }>) {
      if (!VENDOR_KEY_NAMES.has(row.key)) continue;
      const v = unseal(row.value_enc, keyNamed(row.key_name));
      if (v) out[row.key] = v;
      else console.warn("[vendor-keys] a saved key could not be read (its encryption key changed); enter it again", { key: row.key });
    }
  } catch (err) {
    console.warn("[vendor-keys] load failed", { message: (err as Error)?.message });
    return current;
  }
  current = out;
  for (const k of VENDOR_KEY_NAMES) {
    if (fromAzure.has(k)) continue; // a value set in Azure wins
    if (out[k]) { process.env[k] = out[k]; setByUs.add(k); }
    else if (setByUs.has(k)) { delete process.env[k]; setByUs.delete(k); }
  }
  return out;
}

export type VendorKeyView = VendorKeyDef & { set: boolean; preview: string | null; in_azure: boolean };

export function viewOf(values: Record<string, string>): VendorKeyView[] {
  return VENDOR_KEYS.map((d) => {
    const azure = fromAzure.has(d.key);
    const v = azure ? String(process.env[d.key] ?? "") : values[d.key];
    return { ...d, set: Boolean(v), preview: v ? (d.secret ? `••••${v.slice(-4)}` : v) : null, in_azure: azure };
  });
}

export class VendorKeyError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function saveVendorKeys(db: Q, changes: Record<string, unknown>, userId: string | null): Promise<Record<string, string>> {
  const k = sealingKey();
  for (const [name, raw] of Object.entries(changes)) {
    if (!VENDOR_KEY_NAMES.has(name)) throw new VendorKeyError(`unknown_key:${name}`);
    if (fromAzure.has(name)) throw new VendorKeyError("set_in_azure");
    const v = raw === null || raw === undefined ? "" : String(raw).trim();
    if (v.length > 500) throw new VendorKeyError(`too_long:${name}`);
    if (name === "ONFIDO_REGION" && v && !["ca", "us", "eu"].includes(v.toLowerCase())) throw new VendorKeyError("bad_region");
    if (!v) { await db.query(`DELETE FROM vendor_keys WHERE key = $1`, [name]); continue; }
    if (!k) throw new VendorKeyError("no_encryption_key");
    const value = name === "ONFIDO_REGION" ? v.toLowerCase() : v;
    await db.query(
      `INSERT INTO vendor_keys (key, value_enc, key_name, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, key_name = EXCLUDED.key_name, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [name, seal(value, k.key), k.name, userId],
    );
  }
  return loadVendorKeys(db);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startVendorKeyRefresher(db: Q, everyMs = 60_000): void {
  if (timer) return;
  void loadVendorKeys(db);
  timer = setInterval(() => { void loadVendorKeys(db); }, everyMs);
  timer.unref?.();
}

/** Tests only. */
export function resetVendorKeysForTests(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const k of setByUs) delete process.env[k];
  setByUs.clear();
  fromAzure.clear();
  current = {};
}
