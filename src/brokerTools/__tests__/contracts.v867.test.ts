// BF_SERVER_v867_BROKER_TOOLS_CONTRACTS - Word merge (fields split across runs), the PDF, merge values and the SignNow flow.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { docxBlocks, mergeDocx, renderContractPdf, simpleDocx, templateFields, unzip, zip } from "../docx.js";
import { mergeValuesFrom, parseSigners, refreshContract, sendContract, type SignNowApi } from "../contracts.js";

/** A paragraph Word split into three runs: "{{busi" "ness.legal_" "name}}". */
function splitRunDocx(): Buffer {
  const base = unzip(simpleDocx(["# Equipment Lease", "Lessee: PLACEHOLDER", "Payment {{structure.payment}} for {{structure.term_months}} months; vendor {{ vendor.unknown }}"]));
  return zip(base.map((f) => f.name !== "word/document.xml" ? f : { name: f.name, data: Buffer.from(f.data.toString("utf8").replace(
    '<w:r><w:t xml:space="preserve">Lessee: PLACEHOLDER</w:t></w:r>',
    '<w:r><w:t xml:space="preserve">Lessee: {{busi</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ness.legal_</w:t></w:r><w:r><w:t>name}} &amp; co</w:t></w:r>')) }));
}

describe("contracts", () => {
  it("finds fields even when Word splits them across runs, and fills them", () => {
    const docx = splitRunDocx();
    expect(templateFields(docx)).toEqual(["business.legal_name", "structure.payment", "structure.term_months", "vendor.unknown"]);
    const out = mergeDocx(docx, { "business.legal_name": "Dig <North> Ltd.", "structure.payment": "$2,540.10", "structure.term_months": "36" });
    expect(out.missing).toEqual(["vendor.unknown"]);
    const blocks = docxBlocks(out.docx);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual([["heading", "Equipment Lease"], ["para", "Lessee: Dig <North> Ltd. & co"], ["para", "Payment $2,540.10 for 36 months; vendor "]]);
    expect(unzip(out.docx).find((f) => f.name === "word/document.xml")!.data.toString()).toContain("Dig &lt;North&gt; Ltd.");
  });

  it("makes a PDF with a signature page carrying a SignNow tag per signer", async () => {
    const bytes = await renderContractPdf(docxBlocks(simpleDocx(["# Title", "Body ".repeat(400)])), { title: "Lease", footer: "Lease", signers: [
      { name: "Ann Client", email: "ann@example.com", role: "Signer 1" }, { name: "Bob Guarantor", email: "bob@example.com", role: "Signer 2" }] });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(Buffer.from(bytes).toString("latin1")).toMatch(/PDF/);
  });

  it("builds merge values from the deal, the invoice and the chosen structure", () => {
    const v = mergeValuesFrom({
      app: { id: "abcdef12-0000", name: "Dig", requested_amount: "90000", product_category: "EQUIPMENT_FINANCE", metadata: {
        business: { legalName: "Dig North Ltd.", city: "Edmonton", province: "AB" }, applicant: { firstName: "Ann", lastName: "Client" },
        equipment_invoices: [{ vendor: "Prairie Equipment", invoice_number: "INV-1", subtotal: 85000, total: 89250, equipment: [{ description: "Kubota KX040", serial_number: "KX-1" }, { description: "Trailer", vin: "1M8GDM9AXKP042788" }] }] } },
      contact: { name: "Ann Client", email: "ann@example.com" }, company: null, lenderName: "Stride",
      structure: { lender_name: "Northern", term_months: 36, rate: 8.9, rate_kind: "apr", payment: 2540.1, payment_with_tax: 2667.11, financed: 80000, residual: 0 }, today: "2026-11-01",
    });
    expect(v).toMatchObject({ "business.legal_name": "Dig North Ltd.", "client.first_name": "Ann", "deal.amount": "$90,000.00", "deal.reference": "ABCDEF12",
      "equipment.description": "Kubota KX040; Trailer", "equipment.serial_numbers": "KX-1, 1M8GDM9AXKP042788", "equipment.cost": "$85,000.00",
      "structure.rate": "8.9%", "structure.payment_with_tax": "$2,667.11", "structure.residual": "", "lender.name": "Northern", "today": "2026-11-01" });
  });

  it("checks signers", () => {
    expect(parseSigners([])).toBe("Add at least one signer.");
    expect(parseSigners([{ name: "Ann", email: "nope" }])).toBe("Each signer needs a name and an email address.");
    expect(parseSigners([{ name: "Ann", email: "ANN@example.com" }, { name: "Bob", email: "bob@example.com" }])).toEqual([
      { name: "Ann", email: "ann@example.com", role: "Signer 1" }, { name: "Bob", email: "bob@example.com", role: "Signer 2" }]);
  });

  it("sends once to every signer, then files the signed PDF when SignNow says it is complete", async () => {
    let row: Record<string, any> = { id: "c1", application_id: "a1", name: "Lease", status: "generated", signers: [{ name: "Ann", email: "ann@example.com", role: "Signer 1" }],
      docx: simpleDocx(["x"]), pdf: Buffer.from("%PDF"), created_at: new Date(), missing: [], document_ids: {} };
    const q = { query: async (sql: string, p: unknown[] = []) => {
      if (/FROM contract_documents WHERE application_id = \$1 AND id/.test(sql)) return { rows: [row] };
      if (/SET status = 'sent'/.test(sql)) { row = { ...row, status: "sent", signnow_document_id: p[4], signnow_group_id: p[5], sent_at: new Date() }; return { rows: [] }; }
      if (/SET status = 'signed'/.test(sql)) { row = { ...row, status: "signed", signed_at: new Date(), signed_pdf: p[2], document_ids: { signed: JSON.parse(String(p[3])).signed } }; return { rows: [] }; }
      if (/usage_events/.test(sql)) return { rows: [], rowCount: 1 };
      throw new Error("unexpected SQL: " + sql.slice(0, 70));
    } };
    const calls: string[] = [];
    let signed = false;
    const api: SignNowApi = {
      configured: () => true, upload: async () => { calls.push("upload"); return "doc-1"; }, group: async () => { calls.push("group"); return "grp-1"; },
      invite: async (_g, s) => { calls.push(`invite:${s.map((x) => x.email).join(",")}`); }, status: async () => ({ signed, summary: "" }), download: async () => Buffer.from("%PDF signed"),
    };
    const sent = await sendContract(q, "a1", "c1", null, api);
    expect(sent.status).toBe("sent");
    expect(calls).toEqual(["upload", "group", "invite:ann@example.com"]);
    await expect(sendContract(q, "a1", "c1", null, api)).rejects.toThrow("already sent");
    expect((await refreshContract(q, "a1", "c1", api, async () => "d9")).status).toBe("sent");
    signed = true;
    const done = await refreshContract(q, "a1", "c1", api, async () => "d9");
    expect(done).toMatchObject({ status: "signed", document_ids: { signed: "d9" } });
  });
});
