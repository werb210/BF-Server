// BF_SERVER_v811_MOBILE_APPS_REPORT - Marketing > Mobile apps (BF silo). Usage comes from the client app's own
// anonymous events (event "app_*" in analytics_events: platform, device, version, random install id; BF-client v811),
// plus notification and quick sign-in set-ups from their own tables. Store downloads (App Store Connect, Google Play)
// are not connected yet: the report says so instead of showing zeros.
import { pool } from "../../db.js";

export const DEVICES = ["iphone", "ipad", "android", "android_tablet", "web"] as const;
export const EVENTS = ["open", "sign_in", "application_started", "application_submitted", "document_uploaded", "form_submitted"] as const;

export function clampDays(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 365) : 30;
}

const BASE = `FROM analytics_events e
  WHERE e.event LIKE 'app\\_%'
    AND e.created_at >= (now() AT TIME ZONE 'UTC') - make_interval(days => $1::int)`;
const DEVICE = `COALESCE(NULLIF(e.metadata->'properties'->>'device', ''), 'web')`;
const INSTALL = `NULLIF(e.metadata->'properties'->>'install_id', '')`;

export async function mobileAppsReport(days: number) {
  const totals = await pool.query(
    `SELECT ${DEVICE} AS device, substring(e.event from 5) AS event, COUNT(*)::int AS n, COUNT(DISTINCT ${INSTALL})::int AS users
       ${BASE}
      GROUP BY 1, 2`,
    [days],
  );
  const active = await pool.query(
    `SELECT ${DEVICE} AS device,
            COUNT(DISTINCT ${INSTALL}) FILTER (WHERE e.created_at >= (now() AT TIME ZONE 'UTC') - interval '1 day')::int AS d1,
            COUNT(DISTINCT ${INSTALL}) FILTER (WHERE e.created_at >= (now() AT TIME ZONE 'UTC') - interval '7 days')::int AS d7,
            COUNT(DISTINCT ${INSTALL})::int AS period
       ${BASE}
      GROUP BY 1`,
    [days],
  );
  const daily = await pool.query(
    `SELECT to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') AS day, ${DEVICE} AS device, COUNT(DISTINCT ${INSTALL})::int AS users
       ${BASE}
      GROUP BY 1, 2
      ORDER BY 1`,
    [days],
  );
  const signIns = await pool.query(
    `SELECT COALESCE(NULLIF(e.metadata->'properties'->>'method', ''), 'code') AS method, ${DEVICE} AS device, COUNT(*)::int AS n
       ${BASE} AND e.event = 'app_sign_in'
      GROUP BY 1, 2`,
    [days],
  );
  const versions = await pool.query(
    `SELECT ${DEVICE} AS device, COALESCE(NULLIF(e.metadata->'properties'->>'version', ''), 'unknown') AS version,
            COUNT(DISTINCT ${INSTALL})::int AS users, to_char(MAX(e.created_at), 'YYYY-MM-DD') AS last_seen
       ${BASE} AND ${DEVICE} <> 'web'
      GROUP BY 1, 2
      ORDER BY 3 DESC
      LIMIT 30`,
    [days],
  );
  const push = await pool.query(
    `SELECT COALESCE(NULLIF(lower(platform), ''), 'unknown') AS platform, COUNT(DISTINCT user_id)::int AS users
       FROM client_push_tokens WHERE user_id LIKE 'client:%' GROUP BY 1`,
  );
  const quick = await pool.query(
    `SELECT (SELECT COUNT(DISTINCT phone)::int FROM client_device_credentials WHERE revoked_at IS NULL AND expires_at > now()) AS biometric,
            (SELECT COUNT(DISTINCT phone)::int FROM client_passkeys WHERE revoked_at IS NULL) AS passkey`,
  );

  const byDevice: Record<string, Record<string, { count: number; users: number }>> = {};
  for (const d of DEVICES) byDevice[d] = Object.fromEntries(EVENTS.map((ev) => [ev, { count: 0, users: 0 }]));
  for (const r of totals.rows as any[]) {
    if (!byDevice[r.device] || !(EVENTS as readonly string[]).includes(r.event)) continue;
    byDevice[r.device]![r.event] = { count: Number(r.n), users: Number(r.users) };
  }
  const activeBy: Record<string, { d1: number; d7: number; period: number }> = {};
  for (const d of DEVICES) activeBy[d] = { d1: 0, d7: 0, period: 0 };
  for (const r of active.rows as any[]) if (activeBy[r.device]) activeBy[r.device] = { d1: Number(r.d1), d7: Number(r.d7), period: Number(r.period) };

  return {
    days,
    devices: DEVICES,
    active: activeBy,
    events: byDevice,
    daily: (daily.rows as any[]).map((r) => ({ day: r.day, device: r.device, users: Number(r.users) })),
    signInMethods: (signIns.rows as any[]).map((r) => ({ method: r.method, device: r.device, count: Number(r.n) })),
    versions: (versions.rows as any[]).map((r) => ({ device: r.device, version: r.version, users: Number(r.users), lastSeen: r.last_seen })),
    notificationsOn: (push.rows as any[]).map((r) => ({ platform: r.platform, users: Number(r.users) })),
    quickSignIn: { biometric: Number((quick.rows[0] as any)?.biometric ?? 0), passkey: Number((quick.rows[0] as any)?.passkey ?? 0) },
    stores: {
      apple: { connected: false, note: "Connects once Apple approves the company developer account (App Store Connect API key)." },
      google: { connected: false, note: "Connects once the app is live on Google Play (Play Console reports access)." },
    },
  };
}
