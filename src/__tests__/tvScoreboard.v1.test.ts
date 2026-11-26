// BF_SERVER_TV_SCOREBOARD_v1 - the scoreboard maths, a TV's settings, and pairing through KS-Ops.
import { describe, expect, it, vi } from "vitest";
import { computeBoard, monthBounds } from "../scoreboard/scoreboard.js";
import { bfClaim, cleanSettings, hashToken, pairScreen, screenForToken, TOKEN_PREFIX } from "../scoreboard/screens.js";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const people = [
  { user_id: "u1", name: "Ann Able", photo_url: null, team_id: T1, goal: 500000 },
  { user_id: "u2", name: "Bob Baker", photo_url: null, team_id: T2, goal: null },
  { user_id: "u3", name: "Cy Cole", photo_url: null, team_id: T1, goal: 200000 },
  { user_id: "u4", name: "Idle Ida", photo_url: null, team_id: null, goal: null },
];
const teams = [{ id: T1, name: "Eagles", members: ["u1", "u3"] }, { id: T2, name: "Hawks", members: ["u2"] }];
const funded = [
  { id: "a1", broker: "u1", amount: 250000, funded_at: "2026-11-25T18:00:00Z", day: "2026-11-25" },
  { id: "a2", broker: "u2", amount: 140000, funded_at: "2026-11-24T18:00:00Z", day: "2026-11-24" },
  { id: "a3", broker: "u3", amount: 90000, funded_at: "2026-11-23T18:00:00Z", day: "2026-11-23" },
  { id: "a4", broker: "u3", amount: 60000, funded_at: "2026-11-22T18:00:00Z", day: "2026-11-22" },
];

describe("scoreboard", () => {
  it("ranks brokers by funded volume, shows movement since yesterday, and leaves out people with nothing to show", () => {
    const b = computeBoard({ people, teams, funded, today: "2026-11-25", teamIds: null });
    expect(b.brokers.map((x) => [x.name, x.rank, x.volume, x.deals, x.movement])).toEqual([
      ["Ann Able", 1, 250000, 1, 2], ["Cy Cole", 2, 150000, 2, -1], ["Bob Baker", 3, 140000, 1, -1],
    ]);
    expect(b.teams.map((t) => [t.name, t.volume, t.deals, t.goal])).toEqual([["Eagles", 400000, 3, 700000], ["Hawks", 140000, 1, null]]);
    expect(b.office).toEqual({ volume: 540000, deals: 4, goal: 700000 });
    expect(b.recent[0]).toMatchObject({ id: "a1", broker: "Ann Able", amount: 250000 });
    expect(JSON.stringify(b.recent)).not.toMatch(/business|company|client/i);
  });
  it("a TV for one team shows only that team", () => {
    const b = computeBoard({ people, teams, funded, today: "2026-11-25", teamIds: [T2] });
    expect(b.brokers.map((x) => x.name)).toEqual(["Bob Baker"]);
    expect(b.teams.map((t) => t.name)).toEqual(["Hawks"]);
  });
  it("works out the month in the brokerage's time zone", () => {
    expect(monthBounds(new Date("2026-12-01T03:00:00Z"), "America/Edmonton")).toMatchObject({ month: "2026-11", start: "2026-11-01", end: "2026-12-01", days_left: 0, label: "November 2026" });
  });
});

describe("TV settings", () => {
  it("needs a name and at least one known screen; keeps the speed sensible", () => {
    expect(cleanSettings({})).toEqual({ error: expect.any(String) });
    expect(cleanSettings({ name: "Floor", slides: ["nope"] })).toEqual({ error: expect.any(String) });
    expect(cleanSettings({ name: " Floor ", slides: ["teams", "teams", "goal"], rotate_seconds: 2, team_ids: [T1, "x"] }))
      .toEqual({ name: "Floor", slides: ["teams", "goal"], rotate_seconds: 8, team_ids: [T1] });
  });
});

function fakeDb() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (/INSERT INTO tv_screens/.test(sql)) return { rows: [{ id: "s1", name: params[0] }], rowCount: 1 };
      if (/UPDATE tv_screens SET last_seen_at/.test(sql)) return params[0] === hashToken(`${TOKEN_PREFIX}good-token-0123456789abcdefghij`) ? { rows: [{ id: "s1", team_ids: null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("pairing", () => {
  const settings = { name: "Floor", team_ids: null, slides: ["leaderboard"], rotate_seconds: 20 };
  it("keeps the TV only when KS-Ops accepted the code, and stores just the token's hash", async () => {
    const db = fakeDb();
    const claim = vi.fn(async () => ({ ok: true, status: 200 }));
    const out = await pairScreen(db as any, { code: "ab3-k7q", settings, createdBy: "u1", claim });
    expect(out.ok).toBe(true);
    const [code, token] = claim.mock.calls[0] as unknown as [string, string];
    expect(code).toBe("AB3K7Q");
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    const insert = db.calls.find((c) => /INSERT INTO tv_screens/.test(c.sql))!;
    expect(insert.params[1]).toBe(hashToken(token));
    expect(JSON.stringify(insert.params)).not.toContain(token);
  });
  it("says so when the code is wrong or expired", async () => {
    const db = fakeDb();
    expect(await pairScreen(db as any, { code: "12", settings, createdBy: null, claim: vi.fn() })).toMatchObject({ ok: false, status: 400 });
    const out = await pairScreen(db as any, { code: "AB3K7Q", settings, createdBy: null, claim: async () => ({ ok: false, status: 404, message: "That code was not found." }) });
    expect(out).toMatchObject({ ok: false, status: 404, message: "That code was not found." });
    expect(db.calls.some((c) => /INSERT/.test(c.sql))).toBe(false);
  });
  it("claims at KS-Ops with the admin's own sign-in", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }));
    await bfClaim("https://ops.example/", "Bearer admin", fetch as any)("AB3K7Q", "tvs_x");
    expect(fetch).toHaveBeenCalledWith("https://ops.example/api/tv/pair/claim/bf", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer admin" }) }));
  });
  it("a TV's token opens only its own screen", async () => {
    const db = fakeDb();
    expect(await screenForToken(db as any, `Bearer ${TOKEN_PREFIX}good-token-0123456789abcdefghij`)).toMatchObject({ id: "s1" });
    expect(await screenForToken(db as any, `Bearer ${TOKEN_PREFIX}other-token-0123456789abcdefghij`)).toBeNull();
    expect(await screenForToken(db as any, "Bearer staff-jwt")).toBeNull();
  });
});
