import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)),
  "utf-8",
);
const mapper = source.match(
  /function templateFieldsFromBody[\s\S]*?\n}\n\nrouter\.get\("\/email\/template"/,
)?.[0] ?? "";

describe("BF_EMAIL_TWO_COLUMN_FIELDS_v1", () => {
  it("forwards every supported second-column copy alias", () => {
    expect(mapper).toContain("BF_EMAIL_TWO_COLUMN_FIELDS_v1");
    expect(mapper).toContain("b.headline2 || b.secondHeadline || b.rightHeadline || b.column2Headline");
    expect(mapper).toContain("b.body2 || b.secondBody || b.rightBody || b.column2Body");
  });

  it("forwards right-hand image fields and portal composer aliases", () => {
    expect(mapper).toContain("b.rightImageUrl || b.column2ImageUrl");
    expect(mapper).toContain("b.rightImageLink || b.column2ImageLink");
  });

  it("uses the mapper for preview and send rendering", () => {
    expect(source).toContain("renderBrandedEmail(templateFieldsFromBody(req.body || {}))");
    expect(source).toContain("renderBrandedEmail(templateFieldsFromBody(b))");
  });
});
