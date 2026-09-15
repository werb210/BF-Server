// BF_SERVER_SILENT_QUERY_GUARDRAIL_v215
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync("scripts/check-silent-queries.py", "utf-8");
const ci = readFileSync(".github/workflows/ci.yml", "utf-8");

describe("guardrail", () => {
  it("has a baseline, so it does not block every merge on day one", () => {
    expect(existsSync("scripts/silent-queries-baseline.json")).toBe(true);
    const baseline = JSON.parse(readFileSync("scripts/silent-queries-baseline.json", "utf-8"));
    expect(Array.isArray(baseline.keys)).toBe(true);
    expect(baseline.keys.length).toBeGreaterThan(0);
  });

  it("keys on file and table, not line number, so edits do not churn it", () => {
    expect(script).toContain('f"{path}|{table or \'?\'}"');
    expect(script).not.toMatch(/fingerprint\([^)]*line/);
  });

  it("accepts a handler that logs", () => {
    expect(script).toContain("LOGGING = re.compile");
    expect(script).toMatch(/log\(Error\|Warn\|Info\)/);
  });

  it("offers an explicit opt-out rather than forcing a workaround", () => {
    expect(script).toContain("swallow-ok");
  });

  it("names the four features this actually killed", () => {
    for (const s of ["user_presence", "call_logs.user_id", "crm_tasks", "tasks.source"]) {
      expect(script).toContain(s);
    }
  });

  it("runs in CI before the typecheck", () => {
    expect(ci).toContain("scripts/check-silent-queries.py");
    expect(ci.indexOf("check-silent-queries")).toBeLessThan(ci.indexOf("tsc --noEmit"));
  });

  it("never ignores test files, which would hide the real count", () => {
    expect(script).toContain('if "__tests__" in str(f)');
  });
});
