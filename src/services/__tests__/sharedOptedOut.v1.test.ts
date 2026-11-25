// BF_SERVER_SHARED_OPTED_OUT_VIEW_v1 - people who said no to every brand that markets to them leave the main list.
import { describe, expect, it } from "vitest";
import { listPeople, OPTED_OUT_SQL } from "../directory/sharedContacts.js";

function fakeDb() {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  return {
    seen,
    async query(sql: string, params: unknown[] = []) {
      seen.push({ sql, params });
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("opted-out view", () => {
  it("leaves BF out (lenders are stored there, not marketed) and counts the all-brands opt-out", () => {
    expect(OPTED_OUT_SQL).toContain("all_brands_opt_out");
    expect(OPTED_OUT_SQL).toContain("s.brand <> 'BF' AND s.status = 'opted_out'");
    expect(OPTED_OUT_SQL).toContain("s.brand <> 'BF' AND s.status <> 'opted_out'");
  });
  it("hides opted-out people by default", async () => {
    const db = fakeDb();
    await listPeople(db as any, {});
    expect(db.seen[0].sql).toContain(`WHERE NOT ${OPTED_OUT_SQL}`);
  });
  it("shows only them, or everyone, when asked", async () => {
    const only = fakeDb();
    await listPeople(only as any, { opted_out: "only" });
    expect(only.seen[0].sql).toContain(`WHERE ${OPTED_OUT_SQL}`);
    expect(only.seen[0].sql).not.toContain("NOT (p.all_brands_opt_out");
    const all = fakeDb();
    await listPeople(all as any, { opted_out: "include" });
    expect(all.seen[0].sql).not.toContain("all_brands_opt_out IS TRUE OR");
  });
});
