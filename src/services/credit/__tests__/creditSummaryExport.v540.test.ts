// BF_SERVER_BLOCK_v540_CREDIT_SUMMARY_EXPORT
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
vi.mock("../../../db.js", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
import { docxXml, layout, renderDocx, renderPdf, type ExportDoc } from "../creditSummaryExport.js";
import { readZip } from "../../brokerImport/zip.js";
const DOC: ExportDoc = {
  overview: { applicant_name: "A&W Farms", facility_request: "$1,515,000", term: "60M", ltv: "90%" },
  financials: { periods: [{ label: "2022" }, { label: "2023" }], rows: [{ item: "revenue", values: [337736, 1585948] }, { item: "dscr", values: [2.25, 1.1] }] },
  equipment: { total: 1515000, items: [{ year: 2020, make: "Claas", model: "Harvester", hours: 2000, price: 450000 }] },
  sections: [{ key: "overview", title: "Overview", text: "Family farm.\n\n**Farm land**\nAppraised at $2.66MM." }, { key: "rationale", title: "Rationale", text: "", bullets: ["Cash neutral"] }, { key: "risks", title: "Risks", text: "", risks: [{ risk: "Short history", mitigant: "Real estate equity" }] }],
};
const META = { signedBy: "Andrew Polturak", phone: "780-264-8467", date: new Date("2026-09-26T12:00:00Z") };
describe("v540 export", () => {
  it("builds the template layout", () => { const blocks = layout(DOC, META); const flat = JSON.stringify(blocks); expect(blocks[0]).toEqual({ t: "title", text: "A&W Farms" }); expect(flat).toContain("September 2026"); expect(blocks).toContainEqual({ t: "p", text: "Farm land", bold: true }); expect(flat).toContain('["DSCR","2.25x","1.10x"]'); expect(flat).toContain("Risks and mitigants"); });
  it("writes a valid docx zip with escaped XML", () => { const entries = readZip(renderDocx(DOC, META)); expect(entries.map(({ name }) => name)).toEqual(expect.arrayContaining(["[Content_Types].xml", "document.xml"])); expect(entries.find(({ name }) => name === "document.xml")!.data.toString()).toContain("A&amp;W Farms"); expect(docxXml([{ t: "p", text: "<script>" }])).toContain("&lt;script&gt;"); });
  it("renders PDF", async () => { const pdf = await renderPdf(DOC, META); expect(pdf.subarray(0, 5).toString()).toBe("%PDF-"); expect(pdf.length).toBeGreaterThan(1500); });
  it("wires routes and package", () => { expect(fs.readFileSync("src/routes/creditSummaryV2.ts", "utf8")).toContain('router.get("/:applicationId/export.:format"'); expect(fs.readFileSync("src/services/lenders/loadPackageInputs.ts", "utf8")).toContain("BF_SERVER_BLOCK_v540"); });
});
