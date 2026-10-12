// BF_SERVER_SILENT_QUERY_GUARDRAIL_v215
// BF_SERVER_v789_SILENT_QUERIES - behaviour test: runs the real script against
// fixture sources instead of grepping its text.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts/check-silent-queries.py");

function run(files: Record<string, string>, opts: { writeBaseline?: boolean; baseline?: unknown } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "silentq-"));
  const root = join(dir, "src");
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  const baseline = join(dir, "baseline.json");
  if (opts.baseline !== undefined) writeFileSync(baseline, JSON.stringify(opts.baseline));
  const args = [SCRIPT, "--root", root, "--baseline", baseline];
  if (opts.writeBaseline) args.push("--write-baseline");
  try {
    const out = execFileSync("python3", args, { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    return { code: 0, out, baseline };
  } catch (err: any) {
    return { code: err.status as number, out: String(err.stdout ?? "") + String(err.stderr ?? ""), baseline };
  }
}

describe("silent query guardrail", () => {
  it("flags pool.query(...).catch(() => default) without logging", () => {
    const r = run({ "a.ts": "export async function f(pool: any) {\n  const r = await pool.query(`SELECT 1 FROM t`).catch(() => ({ rows: [] }));\n  return r;\n}\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("a.ts:2");
  });

  it("flags runQuery / dbQuery helpers and .then().catch() chains", () => {
    const r = run({
      "b.ts": "export async function f() {\n  await runQuery(`UPDATE x SET y = 1`).catch(() => null);\n  await dbQuery<{ n: number }>(\"SELECT n FROM z\").then((r) => r.rows).catch(() => []);\n}\n",
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("b.ts:2");
    expect(r.out).toContain("b.ts:3");
  });

  it("flags an empty catch around an awaited query", () => {
    const r = run({ "c.ts": "export async function f(pool: any) {\n  try {\n    await pool.query(\"DELETE FROM t\");\n  } catch {}\n}\n" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("empty-catch");
  });

  it("accepts a handler that logs, rethrows, or is marked swallow-ok", () => {
    const r = run({
      "d.ts": [
        "export async function f(pool: any) {",
        "  await pool.query(\"SELECT 1\").catch((err: any) => { logWarn(\"x\", { m: err?.message }); return null; });",
        "  await pool.query(\"SELECT 2\").catch((err: any) => { throw err; });",
        "  // swallow-ok: best effort cache warm",
        "  await pool.query(\"SELECT 3\").catch(() => null);",
        "  try { await pool.query(\"SELECT 4\"); } catch (e) { console.warn(e); }",
        "}",
      ].join("\n"),
    });
    expect(r.code).toBe(0);
  });

  it("ignores test files", () => {
    const r = run({ "__tests__/e.test.ts": "await pool.query(\"SELECT 1\").catch(() => null);\n" });
    expect(r.code).toBe(0);
  });

  it("baselines per occurrence: a second copy of a baselined line is new", () => {
    const one = { "f.ts": "export async function f(pool: any) {\n  await pool.query(\"SELECT 1\").catch(() => null);\n}\n" };
    const w = run(one, { writeBaseline: true });
    const baseline = JSON.parse(readFileSync(w.baseline, "utf8"));
    expect(baseline.total).toBe(1);
    expect(run(one, { baseline }).code).toBe(0);
    // unrelated edit above the line keeps the key
    const shifted = { "f.ts": "// a comment\n\n" + one["f.ts"] };
    expect(run(shifted, { baseline }).code).toBe(0);
    // a duplicate of the same line is a new occurrence
    const twice = { "f.ts": one["f.ts"] + "export async function g(pool: any) {\n  await pool.query(\"SELECT 1\").catch(() => null);\n}\n" };
    expect(run(twice, { baseline }).code).toBe(1);
  });

  it("the committed baseline exists and CI runs the script before the typecheck", () => {
    const baseline = JSON.parse(readFileSync("scripts/silent-queries-baseline.json", "utf-8"));
    expect(typeof baseline.total).toBe("number");
    const ci = readFileSync(".github/workflows/ci.yml", "utf-8");
    expect(ci.indexOf("check-silent-queries")).toBeGreaterThan(-1);
    expect(ci.indexOf("check-silent-queries")).toBeLessThan(ci.indexOf("tsc --noEmit"));
  });
});
