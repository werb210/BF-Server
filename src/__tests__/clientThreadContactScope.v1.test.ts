import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const client = readFileSync(fileURLToPath(new URL("../routes/client/index.ts", import.meta.url)), "utf-8");
const marketing = readFileSync(fileURLToPath(new URL("../routes/marketing.ts", import.meta.url)), "utf-8");
const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/2026_07_30_v2830_email_template_second_column.sql", import.meta.url)),
  "utf-8",
);

describe("BF_CLIENT_THREAD_CONTACT_SCOPE_v1", () => {
  it("widens the client thread beyond a single application", () => {
    expect(client).toContain("BF_CLIENT_THREAD_CONTACT_SCOPE_v1");
    expect(client).toContain("WITH thread AS (");
    expect(client).toContain("contact_id::text = (SELECT contact_id::text FROM thread)");
  });

  it("still anchors the thread on the requested application", () => {
    expect(client).toContain("WHERE application_id::text = ($1)::text");
  });
});

describe("BF_EMAIL_TEMPLATE_SECOND_COLUMN_v1", () => {
  it("adds the four columns idempotently", () => {
    for (const col of ["headline2", "body2", "right_image_url", "right_image_link"]) {
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });

  it("reads the second column back out", () => {
    expect(marketing).toContain("rightImageUrl: row.right_image_url");
    expect(marketing).toContain("headline2: row.headline2");
  });

  it("writes the second column on save", () => {
    expect(marketing).toContain("right_image_url=$12, right_image_link=$13");
    expect(marketing).toContain("f.rightImageUrl ?? \"\"");
  });
});
