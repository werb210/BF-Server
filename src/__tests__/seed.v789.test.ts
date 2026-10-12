// BF_SERVER_v789_SEED_CREATE_ONLY - BOOTSTRAP_ADMIN_PHONE creates the admin only
// when no user has that phone; an existing user is never re-enabled, unlocked,
// re-roled or overwritten. The users table is faked in memory and the mock
// answers by SQL content.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type U = { id: string; email: string; phone_number: string | null; phone: string | null; role: string; disabled: boolean; is_active: boolean; locked_until: string | null };
const users: U[] = [];
const sqlLog: string[] = [];
const digits10 = (s: string | null) => String(s ?? "").replace(/[^0-9]/g, "").slice(-10);

vi.mock("../db.js", () => ({
  pool: { query: vi.fn(), end: vi.fn() },
  runQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    sqlLog.push(sql);
    if (/^\s*select id from users/i.test(sql)) {
      const [phone, d] = params as [string, string];
      const hit = users.find((u) => u.phone_number === phone || u.phone === phone || digits10(u.phone_number) === d || digits10(u.phone) === d);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (/^\s*insert into users/i.test(sql)) {
      const [id, email, phoneNumber, phone, role] = params as string[];
      const clash = users.some((u) => u.id === id || u.email === email || u.phone_number === phoneNumber);
      if (clash) {
        if (/on conflict do nothing/i.test(sql)) return { rows: [] };
        throw new Error("unexpected upsert");
      }
      users.push({ id, email, phone_number: phoneNumber, phone, role, disabled: false, is_active: true, locked_until: null });
      return { rows: [{ id }] };
    }
    if (/^\s*update users/i.test(sql)) throw new Error("seed must never update users");
    return { rows: [] };
  }),
}));
vi.mock("../startup/runMigrations.js", () => ({ runMigrations: vi.fn(async () => undefined) }));

const PHONE = "4035551234";

beforeEach(() => {
  users.length = 0;
  sqlLog.length = 0;
  vi.resetModules();
  vi.stubEnv("BOOTSTRAP_ADMIN_PHONE", PHONE);
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("seedAdminUser (BOOTSTRAP_ADMIN_PHONE)", () => {
  it("creates the admin when no user has the phone", async () => {
    const { seedAdminUser, SEEDED_ADMIN_ID } = await import("../db/seed.js");
    const out = await seedAdminUser();
    expect(out.phoneNumber).toBe("+14035551234");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ id: SEEDED_ADMIN_ID, phone_number: "+14035551234", role: "Admin" });
  });

  it("never re-enables, unlocks, re-roles or overwrites an existing user with that phone", async () => {
    const existing: U = {
      id: "u-1", email: "real.person@example.com", phone_number: "+14035551234", phone: "+14035551234",
      role: "Staff", disabled: true, is_active: false, locked_until: "2099-01-01T00:00:00Z",
    };
    users.push({ ...existing });
    const { seedAdminUser } = await import("../db/seed.js");
    await seedAdminUser();
    expect(users).toHaveLength(1);
    expect(users[0]).toEqual(existing);
    expect(sqlLog.some((s) => /insert into users/i.test(s))).toBe(false);
    expect(sqlLog.some((s) => /do update|update users/i.test(s))).toBe(false);
  });

  it("treats a differently formatted copy of the phone as the same user", async () => {
    users.push({ id: "u-2", email: "x@example.com", phone_number: "(403) 555-1234", phone: null, role: "Staff", disabled: true, is_active: false, locked_until: null });
    const { seedAdminUser } = await import("../db/seed.js");
    await seedAdminUser();
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe("Staff");
    expect(users[0].disabled).toBe(true);
  });

  it("leaves a conflicting row alone (id or email clash) instead of upserting", async () => {
    const { SEEDED_ADMIN_ID } = await import("../db/seed.js");
    users.push({ id: SEEDED_ADMIN_ID, email: "seeded-admin@boreal.financial", phone_number: "+14035559999", phone: null, role: "Staff", disabled: true, is_active: false, locked_until: null });
    const { seedAdminUser } = await import("../db/seed.js");
    await seedAdminUser();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ phone_number: "+14035559999", role: "Staff", disabled: true });
  });

  it("the second bootstrap admin follows the same rule", async () => {
    vi.stubEnv("BOOTSTRAP_ADMIN2_PHONE", "4035550000");
    users.push({ id: "u-3", email: "y@example.com", phone_number: "+14035550000", phone: null, role: "Staff", disabled: true, is_active: false, locked_until: null });
    const { seedSecondAdminUser } = await import("../db/seed.js");
    await seedSecondAdminUser();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ role: "Staff", disabled: true });
  });
});
