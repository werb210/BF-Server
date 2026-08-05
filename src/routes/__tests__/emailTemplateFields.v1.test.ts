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
    expect(src).toContain("landingUrl: row.link_url ?? null");
  });
});
