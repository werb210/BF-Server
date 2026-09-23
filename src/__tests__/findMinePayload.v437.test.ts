// BF_SERVER_FIND_MINE_PAYLOAD_v437
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const src = readFileSync(path.join(process.cwd(), "src/routes/mayaStaff.ts"), "utf8");

describe("v437 the client lookup answers identity questions", () => {
  it("selects the phone Maya was asked for", () => {
    expect(src).toContain("c.phone AS contact_phone");
    expect(src).toContain("phone: first.contact_phone ?? null");
  });

  it("selects a location, from the contact or the application metadata", () => {
    expect(src).toContain("contact_city");
    expect(src).toContain("contact_region");
    expect(src).toContain("city: first.contact_city ?? null");
  });

  it("falls back to the contact when the application join finds nothing", () => {
    expect(src).toContain("if (!first) {");
    expect(src).toContain("FROM contacts");
    expect(src).toContain("ORDER BY updated_at DESC NULLS LAST");
  });

  it("the fallback matches the same normalised last-10 digits", () => {
    const fallback = src.slice(src.indexOf("if (!first) {"));
    expect(fallback).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1");
  });
});
