// KS_SERVER_LICENSEE_DOCUMENTS
import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readDocumentFields, readableName } from "../licenseeDocs/readFields.js";
import { matchByWords, matchFields, questionKey } from "../licenseeDocs/match.js";
import { valuesFor } from "../licenseeDocs/catalog.js";
import { fieldValues, fillDocument } from "../licenseeDocs/fill.js";
import { simpleDocx } from "../brokerTools/docx.js";
import type { ApplicationPdfInputs } from "../signnow/pdfBuilder.js";

async function fillablePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  const add = (name: string, y: number) => { const f = form.createTextField(name); f.addToPage(page, { x: 200, y, width: 300, height: 18 }); };
  add("BusinessLegalName", 700);
  add("txtAmountRequested", 670);
  add("Applicant_Date_of_Birth", 640);
  add("CoApplicantFirstName", 610);
  add("Number of trucks in fleet", 580);
  const cb = form.createCheckBox("Has_existing_equipment_loan"); cb.addToPage(page, { x: 200, y: 550, width: 12, height: 12 });
  return Buffer.from(await doc.save());
}

const APP: ApplicationPdfInputs = {
  applicationId: "aaaaaaaa-1111-4111-8111-111111111111",
  product: { amountRequested: 250000, category: "Equipment" },
  funding: { purposeOfFunds: "Two trucks", industry: "Trucking", yearsInBusiness: "6" },
  business: { legalName: "Northern Haul Ltd.", city: "Red Deer", province: "AB" },
  owners: [{ label: "Owner 1", firstName: "Dana", lastName: "Kim", email: "dana@example.test", dob: "1980-04-02" }, { label: "Owner 2", firstName: "Sam", lastName: "Lee" }],
};

describe("reading a licensee's document", () => {
  it("lists a fillable PDF's fields with readable labels", async () => {
    const r = await readDocumentFields(await fillablePdf(), "form.pdf");
    expect(r.format).toBe("pdf_form");
    expect(r.fields.map((f) => f.label)).toEqual(["Business legal name", "Amount requested", "Applicant date of birth", "Co applicant first name", "Number of trucks in fleet", "Has existing equipment loan"]);
    expect(r.fields[5].type).toBe("checkbox");
  });
  it("lists a Word file's {{fields}}", async () => {
    const r = await readDocumentFields(simpleDocx(["Client: {{client_name}}", "Fee: {{fee_amount}}"]), "agreement.docx");
    expect(r.format).toBe("docx_fields");
    expect(r.fields.map((f) => f.name)).toEqual(["client_name", "fee_amount"]);
  });
  it("says a plain file has nothing to fill", async () => {
    const doc = await PDFDocument.create(); doc.addPage();
    expect((await readDocumentFields(Buffer.from(await doc.save()), "flat.pdf")).format).toBe("none");
  });
  it("makes field names readable", () => {
    expect(readableName("txtBusName[0]")).toBe("Bus name");
    expect(readableName("form1.page1.Owner_Email")).toBe("Owner email");
  });
});

describe("matching fields to the data Keystone collects", () => {
  it("matches by words, keeping the first and second owner apart", () => {
    expect(matchByWords("Business legal name")).toBe("business.legal_name");
    expect(matchByWords("Amount requested")).toBe("deal.amount");
    expect(matchByWords("Applicant date of birth")).toBe("owner1.dob");
    expect(matchByWords("Co applicant first name")).toBe("owner2.first_name");
    expect(matchByWords("Number of trucks in fleet")).toBeNull();
  });
  it("lets the AI fill only what words missed, and only with real keys", async () => {
    const fields = (await readDocumentFields(await fillablePdf(), "f.pdf")).fields;
    const out = await matchFields(fields, async () => JSON.stringify({ "Number of trucks in fleet": "made.up.key", Has_existing_equipment_loan: null }));
    expect(out.find((f) => f.name === "BusinessLegalName")).toMatchObject({ mapped_to: "business.legal_name", matched_by: "words" });
    expect(out.find((f) => f.name === "Number of trucks in fleet")?.mapped_to).toBeNull();
    const ai = await matchFields(fields, async () => JSON.stringify({ "Number of trucks in fleet": "business.employees" }));
    expect(ai.find((f) => f.name === "Number of trucks in fleet")).toMatchObject({ mapped_to: "business.employees", matched_by: "ai" });
  });
  it("works with no AI at all", async () => {
    const out = await matchFields((await readDocumentFields(await fillablePdf(), "f.pdf")).fields, null);
    expect(out.filter((f) => f.mapped_to).length).toBe(4);
  });
  it("gives each unmatched field a stable question key", () => {
    expect(questionKey("Number of trucks in fleet")).toBe("number_of_trucks_in_fleet");
    expect(questionKey("form1[0].Q7[0]")).toBe("form1_q7");
  });
});

describe("filling the document", () => {
  it("fills matched fields from the file and extra fields from the client's answers", async () => {
    const fields = await matchFields((await readDocumentFields(await fillablePdf(), "f.pdf")).fields, null);
    const values = valuesFor({ app: APP, brokerName: "Prairie Capital", extras: { number_of_trucks_in_fleet: "4", has_existing_equipment_loan: true } });
    const byName = fieldValues(fields, values);
    expect(byName).toMatchObject({ BusinessLegalName: "Northern Haul Ltd.", txtAmountRequested: "$250,000", Applicant_Date_of_Birth: "1980-04-02", CoApplicantFirstName: "Sam", "Number of trucks in fleet": "4", Has_existing_equipment_loan: "Yes" });
  });
  it("makes a PDF with a SignNow signature tag for each signer when the form has no signature box", async () => {
    process.env.SBA_NO_FLATTEN = "1";
    try {
      const file = await fillablePdf();
      const fields = await matchFields((await readDocumentFields(file, "f.pdf")).fields, null);
      const pdf = await fillDocument({ name: "Our application", format: "pdf_form", file, fields }, valuesFor({ app: APP, brokerName: "Prairie Capital" }), [{ role: "Owner 1", name: "Dana Kim", email: "dana@example.test" }], "footer");
      const doc = await PDFDocument.load(pdf);
      expect(doc.getForm().getTextField("BusinessLegalName").getText()).toBe("Northern Haul Ltd.");
      expect(doc.getPageCount()).toBe(2);
    } finally { delete process.env.SBA_NO_FLATTEN; }
  });
  it("fills a Word document and lays it out as a PDF", async () => {
    const file = simpleDocx(["# Fee agreement", "Business: {{business_name}}", "Fee: {{fee_amount}}"]);
    const fields = await matchFields((await readDocumentFields(file, "a.docx")).fields, null);
    const pdf = await fillDocument({ name: "Fee agreement", format: "docx_fields", file, fields }, valuesFor({ app: APP, brokerName: "Prairie Capital", fee: { amount: 5000 } }), [{ role: "Client", name: "Dana Kim", email: "dana@example.test" }], "footer");
    expect(Buffer.from(pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
