// BF_SERVER_BACKGROUND_UPLOAD_v306
import { describe, expect, it } from "vitest";
import fs from "node:fs";

describe("background upload flag", () => {
  const docs = fs.readFileSync("src/routes/documents.ts", "utf8");
  const apps = fs.readFileSync("src/modules/applications/applications.routes.ts", "utf8");
  const migration = fs.readFileSync("migrations/2026_09_16_v306_documents_received_in_background.sql", "utf8");

  it("both upload routes read the header the phone sends", () => {
    expect(docs.match(/receivedInBackground: req\.header\("x-background-upload"\) === "1"/g)?.length).toBe(2);
  });
  it("stores it on the document and returns it on the Documents tab", () => {
    expect(docs).toContain("offer_id, received_in_background, created_at, updated_at)");
    expect(docs).toContain("$12,$13,now(),now())");
    expect(apps.match(/AS received_in_background/g)?.length).toBe(2);
    expect(apps).toContain("receivedInBackground: Boolean(");
  });
  it("migration is idempotent", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS received_in_background");
  });
});
