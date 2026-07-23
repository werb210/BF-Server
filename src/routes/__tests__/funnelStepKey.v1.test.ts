// BF_SERVER_FUNNEL_STEP_KEY_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const dashboard = read("src/routes/dashboard.ts");
const clientApps = read("src/routes/client/v1Applications.ts");

describe("funnel reads the step key the server actually writes", () => {
  it("the server normalises both spellings to camelCase", () => {
    // This is why snake_case was always empty.
    expect(clientApps).toContain("out.currentStep = input.currentStep");
    expect(clientApps).toContain("out.currentStep = out.currentStep ?? input.current_step");
  });

  it("the funnel prefers metadata->>'currentStep'", () => {
    expect(dashboard).toContain("NULLIF(metadata->>'currentStep','')::int");
  });

  it("keeps snake_case and the column as fallbacks", () => {
    expect(dashboard).toContain("NULLIF(metadata->>'current_step','')::int");
    expect(dashboard).toContain("current_step, 1) AS step");
  });

  it("applies the same key to the empty-shell exclusion", () => {
    // If the exclusion used a different key from the projection, real
    // applicants would be dropped from the funnel as if they never started.
    const seg = dashboard.slice(dashboard.indexOf("BF_SERVER_FUNNEL_STEP_KEY_v1"));
    const occurrences = seg.split("NULLIF(metadata->>'currentStep','')::int").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});
