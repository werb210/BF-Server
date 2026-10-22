// BF_SERVER_v846_FRAUD - check 14: inside-job alerts.
//
// One observer on the /api router watches finished staff requests (it never changes or delays them) and records
// staff_risk_events for:
//   banking_details_changed - a staff member changed bank account / transit / institution fields on a file (red)
//   approved_own_file       - a staff member moved a file they own to Accepted (amber)
//   bulk_export             - the full data export, or 5+ exports / bulk downloads within an hour (amber)
//   off_hours               - 5+ changes to files between 22:00 and 06:00 Alberta time in one night (amber)
//   high_volume             - more than FRAUD_STAFF_HOURLY_FILE_LIMIT (default 150) different files opened in an hour (amber)
// Admins get an in-app notification for each amber/red event (once per user, kind and day). Only body KEY NAMES are
// recorded - never the values typed. Night hours are Alberta time (ALBERTA_TZ, UTC-6 all year).
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomUUID } from "node:crypto";
import type { Q } from "./types.js";
import { ALBERTA_TZ } from "../lib/albertaTime.js";

export type RiskKind = "banking_details_changed" | "approved_own_file" | "bulk_export" | "off_hours" | "high_volume" | "export" | "off_hours_write";

export type Candidate = { kind: RiskKind; severity: "info" | "amber" | "red"; applicationId: string | null; detail: Record<string, unknown>; needsOwnerCheck?: boolean };

const BANK_KEY = /(^|_|\b)(bank|transit|institution|account_?(no|num|number)|accountnumber|routing|iban|swift|void_?cheque|pad)(_|$|\b)/i;
const STAGE_KEY = /^(stage|pipeline_state|pipelinestate|status|current_stage)$/i;
const ACCEPT = /accept|approv|funded/i;
const EXPORT_PATH = /(^|\/)(export|exports|download-all|bulk-download|zip)(\/|$)|\.csv$/i;
// BF_SERVER_v846_FRAUD - the portal changes files through /api/applications/:id and /api/portal/applications/:id.
const APP_PATH = /^\/(?:portal\/)?applications\/([^/?#]+)/;

/** Body key names (2 levels deep), for the banking-details rule. */
export function bodyKeys(body: unknown, depth = 0): string[] {
  if (!body || typeof body !== "object" || depth > 2) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out.push(k);
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...bodyKeys(v, depth + 1));
  }
  return out;
}

export function localHour(at: Date, timeZone: string): number {
  try {
    return Number(new Intl.DateTimeFormat("en-CA", { hour: "numeric", hourCycle: "h23", timeZone }).format(at));
  } catch {
    return at.getUTCHours();
  }
}

/** What a finished request may mean. Pure: path is relative to /api. */
export function classifyRequest(r: { method: string; path: string; body: unknown; at: Date; timeZone: string }): Candidate[] {
  const out: Candidate[] = [];
  const method = r.method.toUpperCase();
  const appId = r.path.match(APP_PATH)?.[1] ?? null;
  const write = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  if (write && appId) {
    const keys = bodyKeys(r.body);
    const bank = [...new Set(keys.filter((k) => BANK_KEY.test(k)))];
    if (bank.length) out.push({ kind: "banking_details_changed", severity: "red", applicationId: appId, detail: { fields: bank.slice(0, 10) } });
    const body = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
    const stage = Object.entries(body).find(([k, v]) => STAGE_KEY.test(k) && typeof v === "string" && ACCEPT.test(v));
    if (stage || /\/(accept|approve)(\/|$)/i.test(r.path)) out.push({ kind: "approved_own_file", severity: "amber", applicationId: appId, detail: {}, needsOwnerCheck: true });
  }
  if (r.path === "/export" || r.path.startsWith("/export?")) out.push({ kind: "bulk_export", severity: "amber", applicationId: null, detail: { what: "full data export" } });
  else if (EXPORT_PATH.test(r.path.split("?")[0]!)) out.push({ kind: "export", severity: "info", applicationId: appId, detail: { path: r.path.split("?")[0]!.replace(/[0-9a-f-]{16,}/gi, ":id").slice(0, 120) } });
  const hour = localHour(r.at, r.timeZone);
  if (write && (hour >= 22 || hour < 6) && /^\/(?:portal\/)?(applications|documents|contacts|lenders|offers)/.test(r.path)) {
    out.push({ kind: "off_hours_write", severity: "info", applicationId: appId, detail: { hour } });
  }
  return out;
}

export type InsiderDeps = {
  db: () => Promise<Q>;
  timeZone: () => string;
  now?: () => Date;
};

export const INSIDER_TIME_ZONE = ALBERTA_TZ;

// In-memory: distinct files opened per user this hour (per instance; enough to notice a scrape).
const opened = new Map<string, { hour: number; apps: Set<string>; alerted: boolean }>();

export function hourlyFileLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.FRAUD_STAFF_HOURLY_FILE_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 150;
}

export function noteFileOpened(userId: string, appId: string, at: Date, limit = hourlyFileLimit()): boolean {
  const hour = Math.floor(at.getTime() / 3_600_000);
  let e = opened.get(userId);
  if (!e || e.hour !== hour) { e = { hour, apps: new Set(), alerted: false }; opened.set(userId, e); }
  e.apps.add(appId);
  if (e.apps.size > limit && !e.alerted) { e.alerted = true; return true; }
  return false;
}

export function _resetInsiderCounters(): void { opened.clear(); }

function staffUser(req: Request): { id: string; label: string } | null {
  const u = (req as any).user;
  if (!u || u.isServicePrincipal) return null;
  const role = String(u.role ?? "");
  if (!["Admin", "Staff", "Ops", "Marketing"].includes(role)) return null;
  const id = String(u.userId ?? u.id ?? u.sub ?? "");
  if (!id) return null;
  const label = String(u.name ?? u.full_name ?? [u.first_name, u.last_name].filter(Boolean).join(" ") ?? u.email ?? "").trim();
  return { id, label: label || String(u.email ?? "A staff member") };
}

export async function recordRiskEvent(db: Q, e: { userId: string; kind: RiskKind; severity: string; applicationId: string | null; detail: Record<string, unknown>; dedupeKey: string | null }): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO staff_risk_events (user_id, kind, severity, application_id, detail, dedupe_key)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [e.userId, e.kind, e.severity, e.applicationId, JSON.stringify(e.detail ?? {}), e.dedupeKey],
  );
  return r.rows.length > 0;
}

/** Turn a finished request's candidates into stored events (owner check, hourly/nightly roll-ups). */
export async function handleCandidates(db: Q, user: { id: string; label: string }, cands: Candidate[], at: Date): Promise<number> {
  let stored = 0;
  const dayKey = at.toISOString().slice(0, 10);
  const hourKey = at.toISOString().slice(0, 13);
  for (const c of cands) {
    if (c.needsOwnerCheck && c.applicationId) {
      const r = await db.query(`SELECT owner_user_id::text AS owner, pipeline_state FROM applications WHERE id::text = ($1)::text LIMIT 1`, [c.applicationId]);
      const row = r.rows[0];
      if (!row || row.owner !== user.id || !/accept/i.test(String(row.pipeline_state ?? ""))) continue;
      if (await recordRiskEvent(db, { userId: user.id, kind: c.kind, severity: c.severity, applicationId: c.applicationId, detail: { by: user.label }, dedupeKey: `own:${c.applicationId}:${user.id}` })) stored++;
      continue;
    }
    if (c.kind === "export") {
      await recordRiskEvent(db, { userId: user.id, kind: "export", severity: "info", applicationId: c.applicationId, detail: c.detail, dedupeKey: null });
      const n = await db.query(`SELECT COUNT(*)::int AS n FROM staff_risk_events WHERE user_id = $1 AND kind = 'export' AND created_at > now() - interval '1 hour'`, [user.id]);
      if (Number(n.rows[0]?.n ?? 0) >= 5 && await recordRiskEvent(db, { userId: user.id, kind: "bulk_export", severity: "amber", applicationId: null, detail: { by: user.label, exports_last_hour: Number(n.rows[0]?.n) }, dedupeKey: `bulk:${user.id}:${hourKey}` })) stored++;
      continue;
    }
    if (c.kind === "off_hours_write") {
      await recordRiskEvent(db, { userId: user.id, kind: "off_hours_write", severity: "info", applicationId: c.applicationId, detail: c.detail, dedupeKey: null });
      const n = await db.query(`SELECT COUNT(*)::int AS n FROM staff_risk_events WHERE user_id = $1 AND kind = 'off_hours_write' AND created_at > now() - interval '8 hours'`, [user.id]);
      if (Number(n.rows[0]?.n ?? 0) >= 5 && await recordRiskEvent(db, { userId: user.id, kind: "off_hours", severity: "amber", applicationId: c.applicationId, detail: { by: user.label, changes: Number(n.rows[0]?.n) }, dedupeKey: `night:${user.id}:${dayKey}` })) stored++;
      continue;
    }
    const dedupe = c.kind === "banking_details_changed" ? `bank:${c.applicationId}:${user.id}:${hourKey}`
      : c.kind === "bulk_export" ? `bulk:${user.id}:${hourKey}`
      : c.kind === "high_volume" ? `vol:${user.id}:${hourKey}` : null;
    if (await recordRiskEvent(db, { userId: user.id, kind: c.kind, severity: c.severity, applicationId: c.applicationId, detail: { ...c.detail, by: user.label }, dedupeKey: dedupe })) stored++;
  }
  return stored;
}

const ALERT_TEXT: Record<string, string> = {
  banking_details_changed: "changed the banking details on a file",
  approved_own_file: "moved a file they own to Accepted",
  bulk_export: "exported data in bulk",
  off_hours: "changed several files during the night",
  high_volume: "opened an unusual number of files in an hour",
};

/** In-app notification to every active Admin for events not yet alerted. Returns how many events were alerted. */
export async function alertAdmins(db: Q): Promise<number> {
  const ev = await db.query(
    `SELECT id, user_id, kind, application_id, detail FROM staff_risk_events
      WHERE alerted_at IS NULL AND severity IN ('amber', 'red') AND created_at > now() - interval '2 days'
      ORDER BY id ASC LIMIT 50`,
    [],
  );
  if (!ev.rows.length) return 0;
  // BF_SERVER_v846_FRAUD - disabled and deleted Admins are not told.
  const admins = await db.query(`SELECT id::text AS id FROM users WHERE active = true AND COALESCE(disabled, false) = false AND deleted_at IS NULL AND upper(coalesce(role, '')) = 'ADMIN'`, []);
  for (const e of ev.rows) {
    const who = String(e.detail?.by ?? "A staff member");
    const body = `${who} ${ALERT_TEXT[e.kind] ?? e.kind.replace(/_/g, " ")}. Review it in the file's Fraud check tab.`;
    for (const a of admins.rows) {
      if (a.id === e.user_id) continue; // an Admin is not alerted about themselves; other Admins are
      await db.query(
        `INSERT INTO notifications (id, user_id, application_id, type, title, body, metadata, created_at, read_at)
         VALUES ($1, $2, $3, 'fraud_staff_alert', 'Staff activity to review', $4, $5::jsonb, now(), null)`,
        [randomUUID(), a.id, e.application_id, body, JSON.stringify({ staff_risk_event_id: e.id, kind: e.kind })],
      );
    }
    await db.query(`UPDATE staff_risk_events SET alerted_at = now() WHERE id = $1`, [e.id]);
  }
  return ev.rows.length;
}

/** Express middleware: observe finished staff requests. Never blocks, never throws. */
export function staffRiskObserver(deps: InsiderDeps): RequestHandler {
  const now = deps.now ?? (() => new Date());
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      const user = staffUser(req);
      if (!user) return;
      const path = (req.originalUrl || req.url || "").replace(/^\/api(?=\/)/, "").split("?")[0]!;
      const method = req.method;
      const body = req.body;
      void (async () => {
        try {
          const at = now();
          const db = await deps.db();
          const cands = classifyRequest({ method, path, body, at, timeZone: deps.timeZone() });
          const appId = method === "GET" ? path.match(APP_PATH)?.[1] : null;
          if (appId && noteFileOpened(user.id, appId, at)) {
            cands.push({ kind: "high_volume", severity: "amber", applicationId: null, detail: { limit: hourlyFileLimit() } });
          }
          if (cands.length) await handleCandidates(db, user, cands, at);
        } catch (err) {
          console.warn("[fraud-insider] could not record staff activity", { message: (err as Error)?.message ?? String(err) });
        }
      })();
    });
    next();
  };
}
