// BF_SERVER_TV_SCOREBOARD_v1 - office TVs (tv_screens). Pairing: the TV shows a code from KS-Ops; an admin enters it in
// Settings > Screens; we make a read-only screen token, keep only its hash, and hand the token to KS-Ops with the code
// (BF claims with the admin's own sign-in, which KS-Ops checks with us). The TV then calls GET /api/scoreboard/tv with it.
import { createHash, randomBytes } from "node:crypto";
import { SLIDES } from "./scoreboard.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export const TOKEN_PREFIX = "tvs_";
export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newScreenToken = () => TOKEN_PREFIX + randomBytes(32).toString("base64url");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScreenSettings = { name: string; team_ids: string[] | null; slides: string[]; rotate_seconds: number };

/** Cleans what Settings > Screens sends. Missing fields fall back to the defaults (or `base`). */
export function cleanSettings(body: any, base?: Partial<ScreenSettings>): ScreenSettings | { error: string } {
  const b = body ?? {};
  const name = String(b.name ?? base?.name ?? "").trim().slice(0, 80);
  if (!name) return { error: "Give the TV a name, like Sales floor." };
  const rawTeams = b.team_ids === undefined ? base?.team_ids ?? null : b.team_ids;
  const team_ids = Array.isArray(rawTeams) && rawTeams.length ? [...new Set(rawTeams.map(String).filter((x) => UUID.test(x)))].slice(0, 50) : null;
  const rawSlides = Array.isArray(b.slides) ? b.slides : base?.slides ?? ["leaderboard", "teams", "goal", "recent"];
  const slides = [...new Set(rawSlides.map(String).filter((s: string) => (SLIDES as readonly string[]).includes(s)))] as string[];
  if (!slides.length) return { error: "Pick at least one screen to show." };
  const rs = Number(b.rotate_seconds ?? base?.rotate_seconds ?? 20);
  const rotate_seconds = Number.isFinite(rs) ? Math.min(Math.max(Math.round(rs), 8), 300) : 20;
  return { name, team_ids, slides, rotate_seconds };
}

export const SCREEN_COLS = `id::text AS id, name, team_ids::text[] AS team_ids, slides, rotate_seconds, created_at, last_seen_at`;

export async function listScreens(db: Q) {
  return (await db.query(`SELECT ${SCREEN_COLS} FROM tv_screens WHERE removed_at IS NULL ORDER BY created_at`)).rows;
}

/** Pairs a TV: claims the code at KS-Ops first, and only keeps the screen when the claim worked. */
export async function pairScreen(db: Q, input: { code: unknown; settings: ScreenSettings; createdBy: string | null; claim: (code: string, token: string) => Promise<{ ok: boolean; status: number; message?: string }> }) {
  const code = String(input.code ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z2-9]{6}$/.test(code)) return { ok: false as const, status: 400, message: "Enter the 6-character code shown on the TV." };
  const token = newScreenToken();
  const r = await input.claim(code, token);
  if (!r.ok) return { ok: false as const, status: r.status === 404 ? 404 : r.status >= 500 || r.status === 0 ? 502 : r.status, message: r.message || "That code was not found or has expired. Check the code on the TV." };
  const s = input.settings;
  const row = (await db.query(
    `INSERT INTO tv_screens (name, token_hash, team_ids, slides, rotate_seconds, created_by) VALUES ($1, $2, $3::uuid[], $4::text[], $5, $6) RETURNING ${SCREEN_COLS}`,
    [s.name, hashToken(token), s.team_ids, s.slides, s.rotate_seconds, input.createdBy],
  )).rows[0];
  return { ok: true as const, screen: row };
}

/** The screen behind a TV's token, or null. Marks it seen. */
export async function screenForToken(db: Q, raw: unknown) {
  const token = String(raw ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token.startsWith(TOKEN_PREFIX) || token.length < 30) return null;
  const r = await db.query(
    `UPDATE tv_screens SET last_seen_at = now() WHERE token_hash = $1 AND removed_at IS NULL RETURNING ${SCREEN_COLS}`, [hashToken(token)]);
  return r.rows[0] ?? null;
}

/** BF claims a code at KS-Ops with the admin's own sign-in (KS-Ops checks it with this server's /api/auth/me). */
export function bfClaim(opsUrl: string, authorization: string, fetchImpl: Fetcher = globalThis.fetch as unknown as Fetcher) {
  return async (code: string, token: string) => {
    try {
      const res = await fetchImpl(`${opsUrl.replace(/\/+$/, "")}/api/tv/pair/claim/bf`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body: JSON.stringify({ code, token }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, message: typeof body?.message === "string" ? body.message : undefined };
    } catch (err) {
      console.warn("[scoreboard] KS-Ops pairing failed", { message: (err as Error)?.message });
      return { ok: false, status: 0, message: "Could not reach the pairing service. Please try again." };
    }
  };
}
