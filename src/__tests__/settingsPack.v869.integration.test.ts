// BF_SERVER_v869_SETTINGS_PACK - against real Postgres: the settings-pack migration twice; signing one device out ends
// that device's v868 refresh chain (and only that one); "sign out everywhere" ends every session and chain; a saved
// phone menu round-trips and resetting it returns the live default menu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { issueStaffRefresh, rotateStaffRefresh } from "../auth/staffRefresh.js";
import { checkSession, clearSessionCache, openSession, revokeSession, signOutEverywhere } from "../security/sessions.js";
import { loadMenu, resetMenu, saveMenu } from "../phoneMenu/store.js";
import { defaultBorealMenu } from "../phoneMenu/menu.js";

const user = randomUUID();

describe("v869 settings pack (real Postgres)", () => {
  beforeAll(async () => {
    const sql = readFileSync("migrations/2026_11_10_v869_settings_pack.sql", "utf8");
    await pool.query(sql);
    await pool.query(sql);
  });
  afterAll(async () => {
    await pool.query("DELETE FROM staff_refresh_tokens WHERE user_id = $1", [user]);
    await pool.query("DELETE FROM user_sessions WHERE user_id = $1", [user]);
    await resetMenu(pool as any);
  });

  it("signing out one device ends its refresh chain only", async () => {
    const phone = await openSession(pool as any, { userId: user, method: "otp", ip: "10.0.0.1", userAgent: "iPhone" });
    const laptop = await openSession(pool as any, { userId: user, method: "passkey", ip: "10.0.0.2", userAgent: "Macintosh" });
    expect(phone && laptop).toBeTruthy();
    const a = await issueStaffRefresh(pool as any, { userId: user, ksid: phone });
    const b = await issueStaffRefresh(pool as any, { userId: user, ksid: laptop });
    expect(await revokeSession(pool as any, phone!, user, user)).not.toBeNull();
    clearSessionCache();
    expect(await checkSession(pool as any, phone!, user)).toMatchObject({ ok: false, reason: "session_revoked" });
    expect(await checkSession(pool as any, laptop!, user)).toMatchObject({ ok: true, strong: true });
    expect((await rotateStaffRefresh(pool as any, a.refreshToken)).ok).toBe(false);
    const rotated = await rotateStaffRefresh(pool as any, b.refreshToken);
    expect(rotated).toMatchObject({ ok: true, ksid: laptop });
  });

  it("sign out everywhere ends every session and refresh chain", async () => {
    const s = await openSession(pool as any, { userId: user, method: "otp" });
    const r = await issueStaffRefresh(pool as any, { userId: user, ksid: s });
    await signOutEverywhere(pool as any, user, null);
    clearSessionCache();
    expect((await checkSession(pool as any, s!, user)).ok).toBe(false);
    expect((await rotateStaffRefresh(pool as any, r.refreshToken)).ok).toBe(false);
    const open = await pool.query("SELECT count(*)::int AS n FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL", [user]);
    expect(open.rows[0].n).toBe(0);
  });

  it("a saved phone menu round-trips; reset is the live default again", async () => {
    const m = defaultBorealMenu();
    m.greeting.text = "Thank you for calling Boreal.";
    await saveMenu(pool as any, m, null);
    const saved = await loadMenu(pool as any);
    expect(saved.isDefault).toBe(false);
    expect(saved.menu.greeting.text).toBe("Thank you for calling Boreal.");
    await resetMenu(pool as any);
    const back = await loadMenu(pool as any);
    expect(back.isDefault).toBe(true);
    expect(back.menu).toEqual(defaultBorealMenu());
  });
});
