// BF_SERVER_FIND_MINE_PAYLOAD_v437
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = process.cwd();
const src = readFileSync(path.join(root, "src/routes/mayaStaff.ts"), "utf8");
const contactsMigration = readFileSync(
  path.join(root, "migrations/20260426_companies_contacts_partners.sql"), "utf8");

describe("v437 the client lookup answers identity questions", () => {
  it("uses the location columns contacts actually has", () => {
    expect(contactsMigration).toContain("ADD COLUMN IF NOT EXISTS address_city");
    expect(contactsMigration).toContain("ADD COLUMN IF NOT EXISTS address_state");
    expect(src).toContain("c.address_city");
    expect(src).toContain("c.address_state");
  });

  it("does not reference columns contacts lacks", () => {
    const block = src.slice(src.indexOf("BF_SERVER_FIND_MINE_PAYLOAD_v437"));
    expect(block).not.toContain("c.province");
    expect(block).not.toContain("c.city,");
  });

  it("selects the phone Maya was asked for", () => {
    expect(src).toContain("c.phone AS contact_phone");
    expect(src).toContain("phone: first.contact_phone ?? null");
  });

  it("carries the location into the contact block", () => {
    expect(src).toContain("city: first.contact_city ?? null");
    expect(src).toContain("region: first.contact_region ?? null");
  });

  it("falls back to the contact when the application join finds nothing", () => {
    expect(src).toContain("if (!first) {");
    expect(src).toContain("ORDER BY updated_at DESC NULLS LAST");
  });

  it("the fallback normalises the phone the same way", () => {
    const fallback = src.slice(src.indexOf("if (!first) {"));
    expect(fallback).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1");
  });
});
