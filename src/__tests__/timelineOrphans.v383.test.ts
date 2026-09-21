// BF_SERVER_TIMELINE_ORPHANS_v383
import { describe, it, expect } from "vitest";
import fs from "node:fs";

const tl = fs.readFileSync("src/routes/crm/timeline.ts", "utf8");
const crm = fs.readFileSync("src/routes/crm.ts", "utf8");

describe("emails and SMS with no matching contact still reach the contact", () => {
  it("messages fall back to the contact's phones on the last 10 digits", () => {
    expect(tl).toContain("m.contact_id = $1 OR (m.contact_id IS NULL AND EXISTS (");
    expect(tl).toContain("CROSS JOIN LATERAL (VALUES (c.phone), (c.secondary_phone)) AS cp(v)");
    for (const col of ["m.phone_number", "m.from_number", "m.to_number"]) {
      expect(tl).toContain(`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`);
    }
    expect(tl).toContain("length(regexp_replace(coalesce(cp.v, ''), '[^0-9]', '', 'g')) >= 10");
    expect(tl).toContain("AND (m.silo = $2 OR m.silo IS NULL)");
  });
  it("emails fall back to the contact's addresses in the same silo", () => {
    expect(crm).toContain("e.contact_id IS NULL AND EXISTS (");
    expect(crm).toContain("CROSS JOIN LATERAL (VALUES (c.email), (c.secondary_email)) AS ce(v)");
    expect(crm).toContain("AND e.silo = c.silo");
    expect(crm).toContain("NULLIF(lower(trim(ce.v)), '') IS NOT NULL");
    expect(crm).toContain("unnest(array_prepend(e.from_address, e.to_addresses || e.cc_addresses))");
  });
});
