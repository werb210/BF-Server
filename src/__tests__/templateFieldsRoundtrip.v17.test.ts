// BF_SERVER_TEMPLATE_FIELDS_ROUNDTRIP_v17
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const routes = fs.readFileSync(path.resolve(__dirname, "../routes/marketing.ts"), "utf8");
const migration = fs.readFileSync(
  path.resolve(__dirname, "../../migrations/2026_08_05_marketing_template_fields.sql"), "utf8");

describe("marketing template library round-trip", () => {
  it("adds the fields column idempotently", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS fields jsonb");
  });

  it("persists the composer fields on save", () => {
    expect(routes).toContain("INSERT INTO marketing_template (silo, channel, name, body, link_url, subject, html, fields, created_by)");
    expect(routes).toContain("VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)");
  });

  it("serialises fields rather than passing a bare object", () => {
    expect(routes).toContain('JSON.stringify(b.fields)');
  });

  it("returns the fields column on list", () => {
    expect(routes).toContain("SELECT id, channel, name, body, link_url, subject, html, fields, updated_at");
  });
});
