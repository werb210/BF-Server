// BF_SERVER_v868_SLIDING_REFRESH - the rotating staff refresh tokens against real Postgres: the migration twice, a
// sign-in chain that rotates, a used token coming back revokes the chain, and "sign out everywhere" ends every chain.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { REUSE_GRACE_MS, issueStaffRefresh, revokeAllStaffRefresh, rotateStaffRefresh } from "../auth/staffRefresh.js";

const user = randomUUID();

describe("v868 staff refresh tokens (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_09_v868_staff_refresh_tokens.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM staff_refresh_tokens WHERE user_id = $1", [user]);
  });

  it("rotates, refuses a replayed token and revokes its chain", async () => {
    const now = Date.now();
    const first = await issueStaffRefresh(pool as any, { userId: user, tokenVersion: 2 }, now);
    const next = await rotateStaffRefresh(pool as any, first.refreshToken, now + 1000);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.userId).toBe(user);
    expect(next.tokenVersion).toBe(2);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    // inside the grace window: another tab, 409
    expect(await rotateStaffRefresh(pool as any, first.refreshToken, now + 2000)).toMatchObject({ ok: false, status: 409 });
    // after it: a stolen copy, the whole chain is revoked
    expect(await rotateStaffRefresh(pool as any, first.refreshToken, now + REUSE_GRACE_MS + 5000)).toMatchObject({ ok: false, reason: "reused" });
    expect(await rotateStaffRefresh(pool as any, next.refreshToken, now + REUSE_GRACE_MS + 6000)).toMatchObject({ ok: false, status: 401 });
  });

  it("sign out everywhere ends every chain the user has", async () => {
    const a = await issueStaffRefresh(pool as any, { userId: user });
    const b = await issueStaffRefresh(pool as any, { userId: user });
    await revokeAllStaffRefresh(pool as any, user);
    expect((await rotateStaffRefresh(pool as any, a.refreshToken)).ok).toBe(false);
    expect((await rotateStaffRefresh(pool as any, b.refreshToken)).ok).toBe(false);
    const open = await pool.query("SELECT count(*)::int AS n FROM staff_refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL", [user]);
    expect(open.rows[0].n).toBe(0);
  });
});
