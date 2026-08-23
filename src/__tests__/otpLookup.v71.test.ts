// BF_SERVER_OTP_LOOKUP_v71 - a returning client whose application_contacts row
// pointed at the wrong contact was sent back to Step 1 of a form they had
// already finished, with nothing in the logs.
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const SRC = fs.readFileSync("src/routes/auth.ts", "utf8");

describe("the lookup no longer depends on one join", () => {
  it("consults applications.contact_id as well", () => {
    expect(SRC).toContain("LEFT JOIN contacts ac2 ON ac2.id = a.contact_id");
  });

  it("matches on either contact's phone", () => {
    expect(SRC).toContain("OR right(regexp_replace(coalesce(ac2.phone, '')");
  });

  it("no longer INNER JOINs through the join table", () => {
    expect(SRC).not.toContain("INNER JOIN application_contacts ac ON ac.application_id = a.id");
  });

  it("keeps the applicant-role filter on the join it still uses", () => {
    expect(SRC).toContain("ON ac.application_id = a.id AND ac.role = 'applicant'");
  });
});

describe("it still only finds submitted applications", () => {
  it("requires submitted_at", () => {
    expect(SRC).toContain("WHERE a.submitted_at IS NOT NULL");
  });

  it("still needs at least ten digits to compare", () => {
    expect(SRC).toContain("length(regexp_replace($1, '[^0-9]', '', 'g')) >= 10");
  });
});

describe("a failure is visible", () => {
  it("logs rather than degrading silently", () => {
    expect(SRC).toContain('console.warn("[otp] submitted-application lookup failed"');
  });
});
