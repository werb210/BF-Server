// BF_SERVER_SUBMIT_FUNNEL_v1
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.resolve(__dirname, "../client/submitFunnel.ts"), "utf8");

describe("submit funnel", () => {
  it("is authenticated — this is applicant PII", () => {
    // Rows carry phone, email and business name.
    expect(route).toContain("router.use(requireAuth)");
  });

  it("counts every attempt, not only the failures", () => {
    // completionRate is meaningless without the denominator.
    expect(route).toContain("completionRate");
    expect(route).toContain("attempted");
  });

  it("labels rows that died before reporting an error", () => {
    // A submission killed by a closed tab writes no error; those are the ones
    // v842 was built to surface and they must not be silently grouped as null.
    expect(route).toContain("died before it could report");
  });

  it("returns contactable detail, not just aggregates", () => {
    // These applicants can be called back.
    expect(route).toContain("phone");
    expect(route).toContain("business_name");
  });

  it("bounds the window so a scan cannot run away", () => {
    expect(route).toContain("n <= 365");
    expect(route).toContain("LIMIT 100");
  });

  it("parameterises the window rather than interpolating it", () => {
    expect(route).not.toMatch(/interval '\$\{/);
    expect(route.match(/\$1 \|\| ' days'/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
