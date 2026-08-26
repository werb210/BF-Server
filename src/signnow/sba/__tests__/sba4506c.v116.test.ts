// BF_SERVER_SBA_4506C_v116
// BF_SERVER_SBA_4506C_TEST_REFRESH_v122
// v116 wrote this file while SBA_4506C_FIELDS was deliberately empty, and every
// assertion below described that unfinished state: an empty map, a builder that
// bailed on `mapped === 0`, an "EMPTY ON PURPOSE" note. v118 then read the real
// template with pypdf and filled the map, which is exactly what v116 asked for -
// but nobody came back for the test. It has been failing on main ever since,
// asserting that finished work is unfinished.
//
// Rewritten to assert the CURRENT contract rather than deleted, because what it
// was guarding still matters: the 4506-C must not ship blank, must not ship
// unsigned, and must not ship without the two checkboxes the IRS rejects it for.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TEMPLATE_EDITIONS } from "../templates.js";
import { SBA_4506C_FIELDS } from "../fieldMaps.js";

const builder = readFileSync(resolve(__dirname, "..", "sbaFormBuilder.ts"), "utf-8");
const maps = readFileSync(resolve(__dirname, "..", "fieldMaps.ts"), "utf-8");

describe("registration", () => {
  it("4506-C is a known form key", () => { expect(TEMPLATE_EDITIONS).toHaveProperty("form_4506c"); });
  it("the edition is still flagged unconfirmed against the uploaded template", () => {
    expect(TEMPLATE_EDITIONS.form_4506c).toContain("UNCONFIRMED");
  });
  it("the blob name is overridable by env, like the others", () => {
    const t = readFileSync(resolve(__dirname, "..", "templates.ts"), "utf-8");
    expect(t).toContain("process.env.SBA_4506C_BLOB");
  });
});

describe("the field map was read from the real PDF", () => {
  it("is populated, not empty", () => {
    expect(Object.keys(SBA_4506C_FIELDS).length).toBe(57);
  });

  it("uses the full dotted XFA path verbatim", () => {
    expect(SBA_4506C_FIELDS.firstName).toContain("form1[0].page_1[0].");
  });

  it("records that the names came from pypdf, not guesswork", () => {
    expect(maps).toContain("pypdf");
  });

  it("line 8 is twelve positional date boxes", () => {
    expect(SBA_4506C_FIELDS.PERIOD_BOXES).toBe(12);
    expect(SBA_4506C_FIELDS.periodBox(1)).toContain("f1_15");
  });
});

describe("the two checkboxes the IRS rejects the form without", () => {
  it("attest and electronic-signature are both mapped", () => {
    expect(SBA_4506C_FIELDS.attestCheckbox).toBeTruthy();
    expect(SBA_4506C_FIELDS.electronicSignatureCheckbox).toBeTruthy();
  });

  it("the builder ticks both", () => {
    expect(builder).toContain("[F.attestCheckbox]: true");
    expect(builder).toContain("[F.electronicSignatureCheckbox]: true");
  });
});

describe("it still refuses rather than shipping something worse than nothing", () => {
  it("returns null when IVES is not configured, rather than a blank line 5a", () => {
    expect(builder).toContain("sba_4506c_ives_not_configured");
  });

  it("a missing template is logged, not thrown", () => {
    expect(builder).toContain("sba_4506c_template_missing");
  });

  it("never types into the signature field", () => {
    expect(builder).not.toContain("[F.signature]:");
    expect(maps).toContain("a typed signature is not a signature");
  });
});
