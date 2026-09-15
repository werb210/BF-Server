// BF_SERVER_RECENT_CALLS_UNION_v228
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/routes/voiceCalls.ts", "utf-8");
const start = src.indexOf('router.get("/recent-calls"');
const query = src.slice(start, src.indexOf("\n});", start));

function branchColumnCounts(): number[] {
  const inner = query.slice(query.indexOf("FROM ("));
  return inner.split(/\bUNION ALL\b/).flatMap((b) => {
    const m = b.match(/SELECT([\s\S]*?)\n\s*FROM\s/);
    if (!m) return [];
    const proj = m[1].replace(/--[^\n]*/g, "");
    let depth = 0, n = 1;
    for (const ch of proj) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) n++;
    }
    return [n];
  });
}

describe("the union that emptied the Phone tab", () => {
  it("has more than one branch, which is what v203 missed", () => {
    expect(query.split("UNION ALL").length - 1).toBeGreaterThanOrEqual(2);
  });

  it("projects the same number of columns in every branch", () => {
    // Mismatched arity makes Postgres reject the whole statement. The handler
    // returns empty, and the portal renders "None yet." with no error shown.
    const counts = branchColumnCounts();
    expect(counts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(counts).size).toBe(1);
  });

  it("selects disposition in the outer list", () => {
    expect(query).toContain("contact_name, disposition");
  });

  it("projects a disposition from every branch, typed where it is null", () => {
    expect(query).toContain("cl.disposition,");
    expect(query.match(/NULL::text AS disposition/g)?.length).toBe(2);
  });

  it("keeps the inbound and seeded-owner branches that earlier fixes restored", () => {
    expect(query).toContain("cl.direction = 'inbound' AND cl.staff_user_id IS NULL");
    expect(query).toContain("00000000-0000-0000-0000-000000000099");
  });
});
