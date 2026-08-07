// BF_SERVER_EMAIL_TEMPLATE_FULL_FIELDS_v1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../marketing.ts", import.meta.url)),
  "utf-8",
);

describe("GET /templates returns what the composer needs to restore a template", () => {
  it("selects html alongside body/subject", () => {
    expect(src).toContain("SELECT id, channel, name, body, link_url, subject, html, fields, updated_at");
  });

  it("exposes link_url as landingUrl so the composer can show it on pick", () => {
    // BF_SERVER_CI_GREEN_AND_NAME_PRECEDENCE_v30 - was asserting the literal
    // `landingUrl: row.link_url ?? null`, which v28 replaced. The composer still
    // gets landingUrl; it is now rebuilt from the slug against the current host.
    expect(src).toContain("landingUrl: slug ? landingUrlForSlug(slug)");
    expect(src).toContain("slugFromLandingUrl(row.link_url)");
  });
});
