// BF_SERVER_CONTACT_DEDUPE_v73 - two more paths made contacts blind. Todd's
// email carries five records; three share the same phone number.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const REFERRALS = fs.readFileSync("src/modules/referrals/referrals.service.ts", "utf8");
const READINESS = fs.readFileSync("src/modules/readiness/readiness.service.ts", "utf8");

describe("referrals look before inserting", () => {
  it("searches by email or phone", () => {
    expect(REFERRALS).toContain("lower(email) = lower($1)");
    expect(REFERRALS).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)");
  });

  it("reuses the existing id rather than minting a new one", () => {
    expect(REFERRALS).toContain("contactId = found.rows[0].id as");
    expect(REFERRALS).toContain("contactIsNew = false");
  });

  it("only creates when genuinely new", () => {
    expect(REFERRALS).toContain("if (contactIsNew) await createContact({");
  });

  it("tags an existing contact instead of duplicating it", () => {
    expect(REFERRALS).toContain("array['referral']");
  });

  it("still creates the referral if dedupe throws", () => {
    expect(REFERRALS).toContain('console.warn("[referrals] contact dedupe failed, creating new"');
  });
});

describe("readiness compares phones properly", () => {
  it("no longer uses an exact string compare", () => {
    expect(READINESS).not.toContain("or phone = $2");
  });

  it("compares the last ten digits", () => {
    expect(READINESS).toContain("right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)");
  });

  it("needs ten digits before trusting a phone match", () => {
    expect(READINESS).toContain("length(regexp_replace($2, '[^0-9]', '', 'g')) >= 10");
  });

  it("ignores an empty email rather than matching every blank one", () => {
    expect(READINESS).toContain("$1 <> ''");
  });
});
