// BF_SERVER_V140_MIGRATION_FIX_v143
// v140 shipped a DELETE against document_requirements - a table no migration
// creates. The application tolerates its absence behind .catch(); migrations run
// at startup and fail closed, so the server would not boot. tsc and the unit
// suite both passed, because nothing had ever checked a migration against the
// schema the migrations themselves build.
//
// pg-mem cannot execute this SQL (no jsonb_array_elements), so rather than a
// half-working execution harness this checks the property that actually broke:
// every relation a migration writes to must be created by some migration, or
// explicitly guarded.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DIR = resolve(process.cwd(), "migrations");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => readFileSync(resolve(DIR, f), "utf8");

// Comments describe history and often name tables that no longer exist.
const statementsOf = (sql: string) =>
  sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

const CREATED = new Set<string>();
for (const f of FILES) {
  for (const m of statementsOf(read(f)).matchAll(
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["']?(\w+)/gi,
  )) CREATED.add(m[1].toLowerCase());
}

describe("no migration writes to a relation that does not exist", () => {
  it("v140 in particular", () => {
    const statements = statementsOf(read("2026_08_29_v140_sba_drop_bank_statements.sql"));
    expect(statements).not.toContain("document_requirements");
    const targets = [...statements.matchAll(/^\s*(?:UPDATE|DELETE FROM|INSERT INTO)\s+(\w+)/gim)]
      .map((m) => m[1].toLowerCase());
    expect(targets).toEqual(["lender_products"]);
    for (const t of targets) expect(CREATED.has(t)).toBe(true);
  });

  it("and every other migration", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const sql = statementsOf(read(f));
      const guarded = new Set(
        [...sql.matchAll(/to_regclass\('public\.(\w+)'\)/gi)].map((m) => m[1].toLowerCase()),
      );
      for (const m of sql.matchAll(
        /(?:delete\s+from|insert\s+into|alter\s+table(?!\s+if\s+exists))\s+(?:public\.)?["']?(\w+)/gi,
      )) {
        const t = m[1].toLowerCase();
        if (CREATED.has(t) || guarded.has(t)) continue;
        offenders.push(`${f}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
