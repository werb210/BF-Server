// BF_SERVER_BI_HANDOFF_CO_APPLICANT_v390
import { describe, expect, it } from "vitest";
import { buildBiPayload } from "../services/biHandoff.js";

const partner = {
  firstName: "Bo", lastName: "Lee", email: "bo@acme.com", phone: "(403) 555-1234",
  dob: "1980-02-03", street: "1 Main St", city: "Calgary", state: "AB", zip: "T2P 1A1",
  ownership: "40", ssn: "123456789",
};

describe("BI handoff carries the co-applicant", () => {
  it("sends the Step 4 partner as a co-guarantor", () => {
    const p: any = buildBiPayload({ bfApplicationId: "bf-1", legacyApp: { applicant: { firstName: "Ann", partner } } });
    expect(p.co_guarantors).toEqual([{
      first_name: "Bo", last_name: "Lee", email: "bo@acme.com", phone: "+14035551234",
      date_of_birth: "1980-02-03", address: "1 Main St", city: "Calgary", province: "AB",
      postal_code: "T2P 1A1", ownership: 40, relationship: "Co-applicant",
    }]);
  });
  it("never sends the SIN/SSN", () => {
    const p: any = buildBiPayload({ bfApplicationId: "bf-2", legacyApp: { applicant: { partner } } });
    expect(JSON.stringify(p)).not.toContain("123456789");
  });
  it("reads a second applicant or a top-level partner too", () => {
    const a: any = buildBiPayload({ bfApplicationId: "bf-3", legacyApp: { applicants: [{ firstName: "Ann" }, { firstName: "Cy", lastName: "Poe" }] } });
    expect(a.co_guarantors[0].first_name).toBe("Cy");
    const b: any = buildBiPayload({ bfApplicationId: "bf-4", legacyApp: { partner: { first_name: "Di", last_name: "Ng" } } });
    expect(b.co_guarantors[0].last_name).toBe("Ng");
  });
  it("sends none when there is no named partner", () => {
    const p: any = buildBiPayload({ bfApplicationId: "bf-5", legacyApp: { applicant: { partner: { email: "x@y.com" } } } });
    expect(p.co_guarantors).toEqual([]);
  });
});
