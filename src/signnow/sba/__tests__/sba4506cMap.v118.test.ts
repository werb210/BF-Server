// BF_SERVER_SBA_4506C_MAP_v118
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SBA_4506C_FIELDS as F } from "../fieldMaps.js";
const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
describe("field names come from the real template", () => {
  it("uses the XFA hierarchical form, not invented names", () => { expect(F.firstName).toBe("form1[0].page_1[0].name_shown[0].first_name[0]"); expect(F.taxpayerId).toBe("form1[0].page_1[0].name_shown[0].first_ssn[0]"); });
  it("keeps the IRS's own misspellings, which are the actual field names", () => { expect(F.uniqueIdentifier).toContain("unique_identifer"); expect(F.transcriptFormNumber).toContain("transcript_reqeust"); });
  it("line 8 boxes are positional and 1-indexed onto f1_15..f1_26", () => { expect(F.periodBox(1)).toContain("f1_15"); expect(F.periodBox(12)).toContain("f1_26"); expect(F.PERIOD_BOXES).toBe(12); });
});
describe("the two checkboxes that decide whether the IRS processes it", () => {
  it("the attestation box is ticked", () => { expect(builder).toContain("[F.attestCheckbox]: true"); });
  it("the electronic signature box is ticked, because SignNow signs it", () => { expect(builder).toContain("[F.electronicSignatureCheckbox]: true"); });
});
describe("signatures are left to SignNow", () => { it("never types a name into the signature field", () => { expect(builder).not.toContain("[F.signature]:"); expect(builder).not.toContain("[F.spouseSignature]:"); }); });
describe("line 5a and 5d", () => {
  it("come from env, because they are the lender's not the applicant's", () => { expect(builder).toContain("SBA_IVES_PARTICIPANT_NAME"); expect(builder).toContain("SBA_IVES_SOR_MAILBOX_ID"); });
  it("refuse to produce a form when unset", () => { expect(builder).toContain("sba_4506c_ives_not_configured"); expect(builder).toContain("return null;"); });
  it("5d falls back to the IVES participant, which IRS allows", () => { expect(builder).toContain("|| ivesName"); });
});
describe("line 8", () => { it("requests the three most recent complete tax years", () => { expect(builder).toContain("new Date().getFullYear() - 1"); expect(builder).toContain("[0, 1, 2].forEach"); }); });
