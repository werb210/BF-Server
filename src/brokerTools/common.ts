// BF_SERVER_v865_BROKER_TOOLS - helpers shared by the broker tools: the database handle, who is acting, the audit log, and
// small parsing helpers. Nothing here is specific to Keystone or Boreal.
import { pool } from "../db.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const db = (): Q => pool as unknown as Q;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actorId(req: any): string | null {
  const v = String(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? "");
  return UUID_RE.test(v) ? v : null;
}

export function isAdmin(req: any): boolean {
  return req?.user?.role === "Admin";
}

/** Records an audit event for the request's user. Never throws into the caller's answer: a failure is logged loudly,
 *  because the change it describes has already happened. */
export async function audit(req: any, action: string, metadata: Record<string, unknown> = {},
  target: { type?: string | null; id?: string | null } = {}): Promise<void> {
  try {
    await recordAuditEvent({
      actorUserId: actorId(req), targetUserId: null, targetType: target.type ?? null, targetId: target.id ?? null,
      action, success: true, metadata,
      ip: typeof req?.ip === "string" ? req.ip : null,
      userAgent: String(req?.headers?.["user-agent"] ?? "").slice(0, 300) || null,
    });
  } catch (err) {
    console.error("[broker-tools] audit write failed", { action, message: err instanceof Error ? err.message : String(err) });
  }
}

export function str(v: unknown, max = 2000): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t ? t.slice(0, max) : null;
}

/** A number from a form value: "$1,234.50" -> 1234.5; "(12.00)" -> -12. Blank or unreadable -> null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = str(v, 100);
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t);
  const cleaned = t.replace(/[^0-9.]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export const cents = (n: number): number => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;

/** YYYY-MM-DD or null. */
export function isoDate(v: unknown): string | null {
  const t = str(v, 40);
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3]) ? null : `${m[1]}-${m[2]}-${m[3]}`;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const t = String(v ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(t) ? (t as T) : fallback;
}

/** The application row the tools need (id, silo, names, amount, stage), or null. */
export async function loadApplication(q: Q, id: string): Promise<Record<string, any> | null> {
  if (!id || id.length > 80) return null;
  const r = await q.query(
    `SELECT a.id::text AS id, a.silo, a.name, a.pipeline_state, a.requested_amount, a.funded_amount, a.funded_at,
            a.company_id::text AS company_id, a.contact_id::text AS contact_id, a.lender_id::text AS lender_id,
            a.lender_product_id::text AS lender_product_id, a.product_category, a.metadata
       FROM applications a WHERE a.id::text = $1 LIMIT 1`,
    [id],
  );
  return r.rows[0] ?? null;
}
