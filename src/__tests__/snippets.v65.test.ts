// BF_SERVER_SNIPPETS_v65 - snippets extend message_templates rather than
// becoming a third parallel template system.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { renderMergeFields, unresolvedMergeFields, usedMergeFields } from "../services/mergeFields.js";

const MIG = fs.readFileSync("migrations/2026_08_23_v65_snippets.sql", "utf8");
const ROUTE = fs.readFileSync("src/routes/templates.ts", "utf8");

describe("it extends the existing table", () => {
  it("adds team to the channel CHECK", () => {
    expect(MIG).toContain("channel IN ('email','message','sms','team')");
    expect(ROUTE).toContain('"email", "message", "sms", "team"');
  });

  it("is idempotent", () => {
    expect(MIG).toContain("ADD COLUMN IF NOT EXISTS is_snippet");
    expect(MIG).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_shortcut");
  });

  it("lets two people own the same shortcut", () => {
    expect(MIG).toContain("coalesce(owner_user_id");
  });
});

describe("merge fields resolve", () => {
  const ctx = {
    contact: { name: "Todd Werboweski", email: "todd@werboweski.com", phone: "+15878881837" },
    company: { name: "Boreal Financial" },
    user: { name: "Andrew Polturak" },
  };

  it("fills what it knows", () => {
    expect(renderMergeFields("Hi {{contact.first_name}},", ctx)).toBe("Hi Todd,");
    expect(renderMergeFields("from {{company.name}}", ctx)).toBe("from Boreal Financial");
  });

  it("derives a first name from a full name", () => {
    expect(renderMergeFields("{{contact.first_name}}", ctx)).toBe("Todd");
  });

  it("leaves an UNKNOWN field visible rather than blanking it", () => {
    expect(renderMergeFields("Hi {{contact.nickname}}", ctx)).toBe("Hi {{contact.nickname}}");
  });

  it("leaves a known field with no value visible too", () => {
    expect(renderMergeFields("{{user.phone}}", ctx)).toBe("{{user.phone}}");
  });

  it("tolerates spacing and case", () => {
    expect(renderMergeFields("{{ CONTACT.NAME }}", ctx)).toBe("Todd Werboweski");
  });
});

describe("the composer can warn before sending", () => {
  it("lists the fields a snippet uses", () => {
    expect(usedMergeFields("{{contact.name}} at {{company.name}}"))
      .toEqual(["contact.name", "company.name"]);
  });

  it("reports which ones will not resolve", () => {
    const ctx = { contact: { name: "Todd" } };
    expect(unresolvedMergeFields("{{contact.name}} {{company.name}}", ctx))
      .toEqual(["company.name"]);
  });
});

describe("shortcuts are normalised", () => {
  it("strips the hash and lower-cases", () => {
    expect(ROUTE).toContain('replace(/^#+/, "").toLowerCase()');
  });
});
