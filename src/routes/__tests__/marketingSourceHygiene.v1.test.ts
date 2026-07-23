// BF_SERVER_MARKETING_SOURCE_HYGIENE_v1
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(path.join(process.cwd(), "src/routes/marketing.ts"), "utf8");

describe("marketing funnel and sources hygiene", () => {
  it("no longer renders Review and Submitted as two identical rows", () => {
    expect(src).not.toContain('{ key: "step6", label: "Step 6 \\u00b7 Review", count: Number(r.step6) }');
    expect(src).toContain('key: "submitted"');
  });

  it("keeps the submitted count as the final funnel value", () => {
    expect(src).toContain("count: Number(r.submitted)");
  });

  it("never reports our own domains as an acquisition source", () => {
    // A visitor moving from the website to the client app is internal
    // navigation, not a referral.
    expect(src).toContain("'%boreal.financial'");
    expect(src).toContain("'%boreal.insure'");
    expect(src).toContain("'%canadianbusinessfinancing.com'");
  });

  it("internal referrers fall through to direct", () => {
    const seg = src.slice(src.indexOf("BF_SERVER_MARKETING_SOURCE_HYGIENE_v1"));
    expect(seg).toContain("THEN ''");
    expect(seg).toContain("'direct'");
  });

  it("still prefers an explicit utm_source over the referrer", () => {
    expect(src).toContain("NULLIF(metadata->'attribution'->>'utm_source', '')");
  });

  it("extracts the host without a regex backreference", () => {
    // A backreference has to survive both TS template-literal and SQL escaping;
    // getting it wrong returns a literal backslash-1 and fails silently.
    const seg = src.slice(src.indexOf("BF_SERVER_MARKETING_SOURCE_HYGIENE_v1"));
    expect(seg).not.toContain("regexp_replace");
    expect(seg).toContain("split_part(");
  });
});
