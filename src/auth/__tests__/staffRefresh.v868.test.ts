// BF_SERVER_v868_SLIDING_REFRESH - rotating staff refresh tokens: a sliding 7-day idle window, a 30-day hard
// limit from sign-in, single use, and theft detection when a used token comes back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DAY_MS, REUSE_GRACE_MS, SESSION_MAX_MS, accessLifetimeSeconds, issueStaffRefresh, looksLikeRefreshToken,
  parseLifetimeSeconds, refreshExpiry, refreshFieldsForSignIn, resetStaffRefreshPurgeForTests, revokeAllStaffRefresh,
  revokeRefreshToken, rotateStaffRefresh,
} from "../staffRefresh.js";
import { fakeRefreshTable } from "../../__tests__/helpers/fakeRefreshTable.js";

const USER = "11111111-1111-4111-8111-111111111111";
const T0 = Date.UTC(2026, 10, 4, 15, 0, 0);

describe("staff refresh tokens", () => {
  let db: ReturnType<typeof fakeRefreshTable>;
  beforeEach(() => {
    db = fakeRefreshTable();
    resetStaffRefreshPurgeForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("issues an opaque token and stores only its hash", async () => {
    const issued = await issueStaffRefresh(db, { userId: USER }, T0);
    expect(looksLikeRefreshToken(issued.refreshToken)).toBe(true);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]!.token_hash).not.toContain(issued.refreshToken);
    expect(new Date(issued.refreshExpiresAt).getTime()).toBe(T0 + 7 * DAY_MS);
    expect(new Date(issued.sessionExpiresAt).getTime()).toBe(T0 + 30 * DAY_MS);
  });

  it("rotates: the new token works, the old one is used up", async () => {
    const first = await issueStaffRefresh(db, { userId: USER, tokenVersion: 3 }, T0);
    const second = await rotateStaffRefresh(db, first.refreshToken, T0 + DAY_MS);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.userId).toBe(USER);
    expect(second.tokenVersion).toBe(3);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // the idle window slid forward from the refresh
    expect(new Date(second.refreshExpiresAt).getTime()).toBe(T0 + 8 * DAY_MS);
    const third = await rotateStaffRefresh(db, second.refreshToken, T0 + 2 * DAY_MS);
    expect(third.ok).toBe(true);
  });

  it("two tabs refreshing together: the second one is told to wait, nothing is revoked", async () => {
    const first = await issueStaffRefresh(db, { userId: USER }, T0);
    const a = await rotateStaffRefresh(db, first.refreshToken, T0 + 1000);
    const b = await rotateStaffRefresh(db, first.refreshToken, T0 + 2000);
    expect(b).toEqual({ ok: false, status: 409, reason: "in_flight" });
    if (!a.ok) throw new Error("first refresh should work");
    expect((await rotateStaffRefresh(db, a.refreshToken, T0 + 3000)).ok).toBe(true);
  });

  it("a used token presented again later revokes the whole chain", async () => {
    const first = await issueStaffRefresh(db, { userId: USER }, T0);
    const second = await rotateStaffRefresh(db, first.refreshToken, T0 + 1000);
    if (!second.ok) throw new Error("refresh should work");
    const replay = await rotateStaffRefresh(db, first.refreshToken, T0 + 1000 + REUSE_GRACE_MS + 1);
    expect(replay).toEqual({ ok: false, status: 401, reason: "reused" });
    expect((await rotateStaffRefresh(db, second.refreshToken, T0 + 2 * REUSE_GRACE_MS + 5000)).ok).toBe(false);
  });

  it("an idle week signs the user out", async () => {
    const first = await issueStaffRefresh(db, { userId: USER }, T0);
    expect(await rotateStaffRefresh(db, first.refreshToken, T0 + 7 * DAY_MS + 1)).toEqual({ ok: false, status: 401, reason: "expired" });
  });

  it("an active user stays signed in, but never past 30 days from sign-in", async () => {
    let token = (await issueStaffRefresh(db, { userId: USER }, T0)).refreshToken;
    let day = 0;
    for (; day < 40; day++) {
      const r = await rotateStaffRefresh(db, token, T0 + (day + 1) * DAY_MS - 1000);
      if (!r.ok) break;
      expect(new Date(r.refreshExpiresAt).getTime()).toBeLessThanOrEqual(T0 + SESSION_MAX_MS);
      token = r.refreshToken;
    }
    expect(day).toBe(30);
  });

  it("sign-out ends the chain, sign-out-everywhere ends every chain", async () => {
    const phone = await issueStaffRefresh(db, { userId: USER }, T0);
    const desk = await issueStaffRefresh(db, { userId: USER }, T0);
    expect(await revokeRefreshToken(db, phone.refreshToken, T0 + 1)).toBe(true);
    expect((await rotateStaffRefresh(db, phone.refreshToken, T0 + 2)).ok).toBe(false);
    expect((await rotateStaffRefresh(db, desk.refreshToken, T0 + 3)).ok).toBe(true);
    await revokeAllStaffRefresh(db, USER, T0 + 4);
    expect(db.rows.every((r) => r.revoked_at)).toBe(true);
    expect(await revokeRefreshToken(db, "not-a-token")).toBe(false);
  });

  it("rejects anything that is not one of its tokens without touching the database", async () => {
    const spy = vi.fn(db.query);
    expect(await rotateStaffRefresh({ query: spy }, "eyJhbGciOi.not.ours")).toEqual({ ok: false, status: 401, reason: "invalid" });
    expect(spy).not.toHaveBeenCalled();
    expect(await rotateStaffRefresh(db, "srt_" + "A".repeat(43))).toEqual({ ok: false, status: 401, reason: "invalid" });
  });

  it("a database failure at sign-in is logged and the sign-in goes on without a refresh token", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await refreshFieldsForSignIn({ query: async () => { throw new Error("db down"); } }, { userId: USER });
    expect(out).toEqual({});
    expect(err).toHaveBeenCalled();
  });

  it("caps refresh expiry and access lifetime at the session limit", () => {
    const start = new Date(T0);
    expect(refreshExpiry(start, T0 + 28 * DAY_MS).getTime()).toBe(T0 + 30 * DAY_MS);
    expect(accessLifetimeSeconds("7d", start, T0)).toBe(7 * 86400);
    expect(accessLifetimeSeconds("7d", start, T0 + 29 * DAY_MS)).toBe(86400);
    expect(accessLifetimeSeconds("7d", start, T0 + 30 * DAY_MS)).toBe(60);
    expect(parseLifetimeSeconds("12h")).toBe(43200);
    expect(parseLifetimeSeconds(900)).toBe(900);
    expect(parseLifetimeSeconds("soon")).toBe(7 * 86400);
  });
});
