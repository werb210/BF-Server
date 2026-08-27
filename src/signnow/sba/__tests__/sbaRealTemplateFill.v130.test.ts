// BF_SERVER_SBA_RADIO_FIX_v130
// Fills the REAL SBA templates and reads the values back off the PDF. Every
// other SBA test asserts against source text, which is why a form that shipped
// with four blank mandatory answers passed all of them for months.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { PDFDocument } from "pdf-lib";

const TEMPLATES: Record<string, string> = {
  "sba-form-1919-02-2025.pdf": "/mnt/user-data/uploads/sba-form-1919-02-2025.pdf",
  "sba-form-413-05-2024.pdf": "/mnt/user-data/uploads/sba-form-413-05-2024.pdf",
  "sba-form-912-12-2028.pdf": "/mnt/user-data/uploads/sba-form-912-12-2028.pdf",
};
const available = Object.values(TEMPLATES).every((p) => existsSync(p));

vi.mock("../../blobStorage.js", () => ({
  downloadBlobAsset: async (name: string) =>
    TEMPLATES[name] && existsSync(TEMPLATES[name]) ? readFileSync(TEMPLATES[name]) : null,
}));

const owner: any = {
  index: 1, firstName: "Dana", lastName: "Okafor", fullName: "Dana Okafor",
  email: "d@x.ca", title: "Managing Member", ownershipPercent: 60,
  ssn: "123-45-6789", dob: "1980-04-02", homeAddress: "18 Rue Principale, Gatineau QC",
  homePhone: "819-555-0142", placeOfBirth: "Regina, SK", usCitizen: "yes",
  alienRegistrationNumber: "", formerNames: "", priorAddress: "9 Elm, Ottawa ON",
  q8: "no", q9: "no", q10: "yes",
  veteranStatus: "veteran", sex: "female", race: "black", ethnicity: "not_hispanic",
};

async function readFields(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const out: Record<string, string | null> = {};
  for (const f of doc.getForm().getFields()) {
    const n = f.getName();
    const kind = f.constructor.name;
    try {
      if (kind === "PDFRadioGroup") out[n] = doc.getForm().getRadioGroup(n).getSelected() ?? null;
      else if (kind === "PDFCheckBox") out[n] = doc.getForm().getCheckBox(n).isChecked() ? "on" : null;
      else out[n] = doc.getForm().getTextField(n).getText() ?? null;
    } catch { out[n] = null; }
  }
  return out;
}

describe.skipIf(!available)("912 against the real template", () => {
  let f: Record<string, string | null>;
  beforeAll(async () => {
    process.env.SBA_NO_FLATTEN = "1";
    const { buildSba912 } = await import("../sbaFormBuilder.js");
    const out = await buildSba912({ business: { legalName: "Northline Ltd", address: "44 Way", city: "Ottawa", state: "ON", zip: "K1A0B1" }, owner });
    expect(out).toBeTruthy();
    f = await readFields(out as Uint8Array);
  });

  it("answers question 6, citizenship", () => {
    expect(f["Are you a United States Citizen?"]).toBe("Yes, I'm a United States Citizen");
  });

  it("answers question 8, incarceration - blank before v130", () => {
    const k = Object.keys(f).find((x) => x.startsWith("Are you currently incarcerated"))!;
    expect(f[k]).toBe("No");
  });

  it("answers question 9, riot or civil disorder - blank before v130", () => {
    const k = Object.keys(f).find((x) => x.startsWith("9. In the past year"))!;
    expect(f[k]).toBe("No");
  });

  it("answers question 10, child support, and carries a Yes through", () => {
    const k = Object.keys(f).find((x) => x.startsWith("10. Are you currently more than 60 days"))!;
    expect(f[k]).toBe("Yes");
  });
});

describe.skipIf(!available)("1919 against the real template", () => {
  let f: Record<string, string | null>;
  beforeAll(async () => {
    process.env.SBA_NO_FLATTEN = "1";
    const { buildSba1919 } = await import("../sbaFormBuilder.js");
    const out = await buildSba1919({
      applicationId: "a1",
      business: { legalName: "Northline Ltd", businessStructure: "LLC", sbaQ4Criminal: "no" },
      kyc: {},
      form1919: {
        purpose_other: "5000", purpose_other_label: "Signage",
        purpose_other_2: "2500", purpose_other_2_label: "Permits",
        q5_exports: "yes", q5_export_sales: "180000",
        q5_exports_detail: "United States, Mexico",
        q6_broker_fee: "no", q13_legal_action: "yes",
      },
      owners: [owner],
    });
    expect(out).toBeTruthy();
    f = await readFields(out as Uint8Array);
  });

  it("describes the first Other purpose - blank before v130", () => {
    expect(f.other1spec).toBe("Signage");
    expect(f.otherAmt1).toBe("5000");
  });

  it("still describes the second Other purpose", () => {
    expect(f.other2spec).toBe("Permits");
  });

  it("puts a dollar amount in 5.a, not the country list", () => {
    expect(f.expSalesTot).toBe("180000");
    expect(f.expCtry1).toBe("United States");
    expect(f.expCtry2).toBe("Mexico");
  });

  it("routes printed questions to their own number", () => {
    expect(f.q5Yes).toBe("on");
    expect(f.q6No).toBe("on");
    expect(f.q13Yes).toBe("on");
  });

  it("writes the demographic block", () => {
    expect(f.ownName).toBe("Dana Okafor");
    expect(f.statVet).toBe("on");
    expect(f.female).toBe("on");
    expect(f.raceBAA).toBe("on");
  });
});
