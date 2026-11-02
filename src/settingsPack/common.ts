// BF_SERVER_v869_SETTINGS_PACK - small helpers shared by the settings-pack routes: who is acting, the audit log, and a
// key/value store for brokerage-wide switches (boreal_settings, migrations/2026_11_02_ks_sp1_phone_menu.sql).
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { clientIpFromRequest } from "../middleware/clientIp.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actorId(req: any): string | null {
  const v = String(req?.user?.userId ?? req?.user?.id ?? req?.user?.sub ?? "");
  return UUID_RE.test(v) ? v : null;
}

export function isAdmin(req: any): boolean {
  return req?.user?.role === "Admin";
}

/** Records an audit event for the request's user (ip and browser included). Never throws into the caller's answer:
 *  a failure is logged loudly, because the change it describes has already happened. */
export async function auditFor(req: any, action: string, metadata: Record<string, unknown> = {},
  target: { type?: string | null; id?: string | null; userId?: string | null } = {}): Promise<void> {
  try {
    let ip: string | null = null;
    try { ip = req?.headers ? clientIpFromRequest(req) || null : null; } catch { ip = null; }
    await recordAuditEvent({
      actorUserId: actorId(req), targetUserId: target.userId ?? null, targetType: target.type ?? null, targetId: target.id ?? null,
      action, success: true, metadata, ip, userAgent: String(req?.headers?.["user-agent"] ?? "").slice(0, 300) || null,
    });
  } catch (err) {
    console.error("[settings-pack] audit write failed", { action, message: err instanceof Error ? err.message : String(err) });
  }
}

/** A brokerage-wide setting (JSON), or the fallback when none is saved. */
export async function readSetting<T>(db: Q, key: string, normalize: (raw: unknown) => T): Promise<T> {
  const r = await db.query(`SELECT value FROM boreal_settings WHERE key = $1`, [key]);
  return normalize(r.rows[0]?.value);
}

export async function writeSetting(db: Q, key: string, value: unknown, actor: string | null): Promise<void> {
  await db.query(
    `INSERT INTO boreal_settings (key, value, updated_at, updated_by) VALUES ($1, $2::jsonb, now(), $3::uuid)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), actor],
  );
}
