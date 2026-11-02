// BF_SERVER_v869_SETTINGS_PACK_NEVER_LOG - email addresses and domains whose mail is never logged to the CRM or auto-filed
// (Settings > Never log, Admins). Personal, legal or HR mail stays off contact timelines.
//
// Applies to everything the server logs or files on its own: Outlook inbox replies (mailReplyWorker), Outlook sent
// items (modules/o365/sentItemsLog.ts), Gmail inbox and sent mail (gmailSyncWorker) and inbound attachments
// (services/contactDocuments.ts fileInboundAttachments). A message a person sends from the CRM, or an attachment they
// file by hand, is still logged: that is a deliberate choice on a contact.
//
// A domain entry covers its subdomains (example.com also covers mail.example.com).
import type { Q } from "../settingsPack/common.js";

export type NeverLogEntry = { id: string; value: string; kind: "email" | "domain"; note: string | null; created_at: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "Jane@Example.com" -> email; "@example.com" / "example.com" -> domain; anything else is refused. */
export function parseEntry(raw: unknown): { ok: true; value: string; kind: "email" | "domain" } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "");
  if (!v) return { ok: false, error: "Enter an email address or a domain." };
  if (v.includes("@") && !v.startsWith("@")) {
    return EMAIL_RE.test(v) && v.length <= 254 ? { ok: true, value: v, kind: "email" } : { ok: false, error: "That is not an email address." };
  }
  const d = v.replace(/^@/, "").replace(/^\*\./, "");
  return DOMAIN_RE.test(d) ? { ok: true, value: d, kind: "domain" } : { ok: false, error: "That is not a domain like example.com." };
}

export function addressDomain(address: string): string {
  const a = String(address ?? "").trim().toLowerCase();
  const at = a.lastIndexOf("@");
  return at >= 0 ? a.slice(at + 1) : "";
}

/** A matcher over a list of entries. */
export function matcher(entries: Array<Pick<NeverLogEntry, "value" | "kind">>): (address: string) => boolean {
  const emails = new Set(entries.filter((e) => e.kind === "email").map((e) => e.value));
  const domains = entries.filter((e) => e.kind === "domain").map((e) => e.value);
  return (address: string) => {
    const a = String(address ?? "").trim().toLowerCase();
    if (!a) return false;
    if (emails.has(a)) return true;
    const d = addressDomain(a);
    return Boolean(d) && domains.some((x) => d === x || d.endsWith(`.${x}`));
  };
}

let cache: { at: number; test: (a: string) => boolean } | null = null;
const CACHE_MS = 60_000;

export function clearNeverLogCache(): void {
  cache = null;
}

/** The list as a matcher (cached a minute). A read failure is logged and nothing is blocked: logging carries on as it
 *  did before the list existed rather than dropping mail silently. */
export async function neverLogMatcher(db: Q, now = Date.now()): Promise<(address: string) => boolean> {
  if (cache && now - cache.at < CACHE_MS) return cache.test;
  try {
    const r = await db.query(`SELECT value, kind FROM never_log_entries`);
    cache = { at: now, test: matcher(r.rows as Array<Pick<NeverLogEntry, "value" | "kind">>) };
    return cache.test;
  } catch (err) {
    console.error("[never-log] list could not be read; mail is logged as before", { message: err instanceof Error ? err.message : String(err) });
    return () => false;
  }
}

/** True when this address must not be logged or auto-filed. */
export async function isNeverLogged(db: Q, address: string | null | undefined): Promise<boolean> {
  if (!address) return false;
  return (await neverLogMatcher(db))(address);
}

export async function listEntries(db: Q): Promise<NeverLogEntry[]> {
  const r = await db.query(`SELECT id::text AS id, value, kind, note, created_at FROM never_log_entries ORDER BY kind, value LIMIT 2000`);
  return r.rows as NeverLogEntry[];
}

export async function addEntry(db: Q, e: { value: string; kind: "email" | "domain"; note: string | null; actor: string | null }): Promise<NeverLogEntry | null> {
  const r = await db.query(
    `INSERT INTO never_log_entries (value, kind, note, created_by) VALUES ($1, $2, $3, $4::uuid)
     ON CONFLICT (value) DO NOTHING RETURNING id::text AS id, value, kind, note, created_at`,
    [e.value, e.kind, e.note, e.actor]);
  clearNeverLogCache();
  return (r.rows[0] as NeverLogEntry) ?? null;
}

export async function removeEntry(db: Q, id: string): Promise<NeverLogEntry | null> {
  const r = await db.query(`DELETE FROM never_log_entries WHERE id::text = $1 RETURNING id::text AS id, value, kind, note, created_at`, [id]);
  clearNeverLogCache();
  return (r.rows[0] as NeverLogEntry) ?? null;
}
