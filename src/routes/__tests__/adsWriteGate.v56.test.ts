// BF_SERVER_ADS_WRITE_GATE_v56
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { adsMutateAllowed, ADS_MUTATE_BLOCKED_REASON, applySuggestion } from "../../services/googleAdsSuggestions.js";

const original = process.env.GOOGLE_ADS_ALLOW_MUTATE;
afterEach(() => {
  if (original === undefined) delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
  else process.env.GOOGLE_ADS_ALLOW_MUTATE = original;
});

describe("campaign changes are off by default", () => {
  it("refuses when the flag is unset", () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    expect(adsMutateAllowed()).toBe(false);
  });

  it("refuses for anything other than an explicit true", () => {
    // Google approved an "internal reporting and Offline conversion" tool that
    // "does not allow users to create or manage campaigns". A typo in the env
    // var must not open the mutate path.
    for (const v of ["", "false", "0", "no", "yes", "1", "TRUE-ish"]) {
      process.env.GOOGLE_ADS_ALLOW_MUTATE = v;
      expect(adsMutateAllowed()).toBe(false);
    }
  });

  it("allows only an explicit true, case and space insensitive", () => {
    for (const v of ["true", "TRUE", " True "]) {
      process.env.GOOGLE_ADS_ALLOW_MUTATE = v;
      expect(adsMutateAllowed()).toBe(true);
    }
  });

  it("blocks applySuggestion before it reaches Google", async () => {
    delete process.env.GOOGLE_ADS_ALLOW_MUTATE;
    const r = await applySuggestion({ type: "pause_campaign", resourceName: "customers/1/campaigns/2" } as any);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(ADS_MUTATE_BLOCKED_REASON);
  });

  it("explains why in terms someone can act on", () => {
    expect(ADS_MUTATE_BLOCKED_REASON).toContain("internal reporting and offline conversions only");
    expect(ADS_MUTATE_BLOCKED_REASON).toContain("GOOGLE_ADS_ALLOW_MUTATE=true");
  });
});

describe("the route refuses visibly", () => {
  const src = readFileSync("src/routes/marketing.ts", "utf8");

  it("returns 403 rather than a 200 carrying ok:false", () => {
    // A blocked attempt should look blocked in the logs, not like an ordinary
    // failed apply.
    expect(src).toContain('res.status(403).json({ ok: false, error: "ads_mutate_disabled"');
  });

  it("checks the gate before reading the action", () => {
    const handler = src.slice(src.indexOf('router.post("/google-ads/suggestions/apply"'), src.indexOf("linkedin-ads/suggestions"));
    expect(handler.indexOf("adsMutateAllowed()")).toBeLessThan(handler.indexOf("req.body.action"));
  });
});

describe("read paths are untouched", () => {
  const svc = readFileSync("src/services/googleAdsSuggestions.ts", "utf8");
  const src = readFileSync("src/routes/marketing.ts", "utf8");

  it("does not gate buildSuggestions", () => {
    const build = svc.slice(svc.indexOf("export async function buildSuggestions"), svc.indexOf("async function mutate("));
    expect(build).not.toContain("adsMutateAllowed");
  });

  it("leaves the conversion upload route alone", () => {
    const upload = src.slice(src.indexOf("google-ads/conversions/upload"), src.indexOf("google-ads/conversions/upload") + 600);
    expect(upload).not.toContain("adsMutateAllowed");
  });
});
