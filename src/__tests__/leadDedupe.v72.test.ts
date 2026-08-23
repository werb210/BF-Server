// BF_SERVER_LEAD_DEDUPE_v72 - createCrmLead inserted unconditionally, so the
// credit-readiness form and the contact form each made a fresh lead for the
// same person. One email currently carries five contact records.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/modules/crm/crm.service.ts", "utf8");

describe("it looks before it inserts", () => {
  it("matches on email", () => {
    expect(SRC).toContain("lower(email) = $1");
  });

  it("matches on phone digits, so formatting does not matter", () => {
    expect(SRC).toContain("regexp_replace(coalesce(phone, ''), '\\\\D', '', 'g')");
    expect(SRC).toContain('(input.phone ?? "").replace(/\\D/g, "")');
  });

  it("needs ten digits before trusting a phone match", () => {
    expect(SRC).toContain("length($2) >= 10");
  });

  it("takes the oldest match, so history accumulates on one record", () => {
    expect(SRC).toContain("order by created_at asc");
  });
});

describe("an update cannot lose data", () => {
  it("coalesces every field, so a sparse submission does not erase a full one", () => {
    expect(SRC).toContain("coalesce(nullif($2,''), company_name)");
    expect(SRC).toContain("coalesce(nullif($5,''), email)");
  });

  it("accumulates tags rather than replacing them", () => {
    expect(SRC).toContain("select distinct e from unnest");
  });

  it("returns the existing id rather than a new one", () => {
    expect(SRC).toContain("return { id: existingId };");
  });
});

describe("it fails safe", () => {
  it("still inserts if the lookup throws", () => {
    expect(SRC).toContain('console.warn("[crm] lead dedupe lookup failed, inserting new"');
  });

  it("skips the lookup entirely with neither key", () => {
    expect(SRC).toContain("if (dedupeEmail || dedupePhone) {");
  });
});
