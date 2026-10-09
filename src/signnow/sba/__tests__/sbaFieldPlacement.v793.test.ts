// BF_SERVER_SBA_FIELD_PLACEMENT_v793
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from "pdf-lib";
import { fillAcroForm } from "../fillAcroForm.js";
import { stampSbaSignDate, formatSbaDate } from "../sbaSignDate.js";
import { SBA_413_FIELDS } from "../fieldMaps.js";

async function tpl(fields: Array<{ name: string; y: number; h: number }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  for (const f of fields) form.createTextField(f.name).addToPage(page, { x: 60, y: f.y, width: 180, height: f.h });
  return doc.save();
}
async function pageText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const c = doc.getPages()[0]!.node.Contents();
  const refs = c instanceof PDFArray ? c.asArray() : [c];
  return refs.map((r) => { const s = doc.context.lookup(r as any) as PDFRawStream; const raw = Buffer.from(s.contents); return (s.dict.get(PDFName.of("Filter")) ? inflateSync(raw) : raw).toString("latin1"); }).join("\n");
}
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

describe("SBA field placement", () => {
  it("puts the SignNow tag at the top of the signature box so the signature lands inside it", async () => {
    const out = await fillAcroForm(await tpl([{ name: "Signature", y: 120, h: 24 }]), {}, [{ field: "Signature", type: "s", role: "Owner 1" }]);
    const text = await pageText(out);
    // widget rect is y 119.5, h 25 -> top 144.5; tag baseline at top - 6 = 138.5
    const m = /1 0 0 1 ([\d.]+) ([\d.]+) Tm\s*\n?<([0-9A-F]+)> Tj/i.exec(text) ?? /([\d.]+) ([\d.]+) Td\s*\n?<([0-9A-F]+)> Tj/i.exec(text);
    expect(text.toUpperCase()).toContain(hex('o:"Owner 1"'));
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBeCloseTo(138.5, 0);
  });
  it("writes the signing date into the form's Date box", async () => {
    const template = await tpl([{ name: SBA_413_FIELDS.date, y: 200, h: 16 }]);
    const signed = await PDFDocument.create(); signed.addPage([612, 792]);
    const out = await stampSbaSignDate("sba-413-owner1-x.pdf", Buffer.from(await signed.save()), "10/09/2026", async () => template);
    expect((await pageText(out)).toUpperCase()).toContain(hex("10/09/2026"));
  });
  it("leaves documents it does not know alone", async () => {
    const pdf = Buffer.from("not-a-form");
    expect(await stampSbaSignDate("boreal-application-owner1-x.pdf", pdf, "10/09/2026")).toBe(pdf);
  });
  it("formats the date the way the SBA and IRS forms expect, in Alberta time", () => {
    expect(formatSbaDate(new Date("2026-10-09T05:30:00Z"))).toBe("10/08/2026"); // 11:30 pm Oct 8 in Alberta
    expect(formatSbaDate(new Date("2026-10-09T16:00:00Z"))).toBe("10/09/2026");
  });
  it("blank titles say Owner", () => {
    const b = readFileSync("src/signnow/sba/sbaFormBuilder.ts", "utf8");
    expect(b).toContain('[F19.repTitle]: owners[0]?.title || "Owner"');
    expect(b).toContain('[F12.title]: o.title || "Owner"');
  });
  it("the lender package carries each signed SBA form and the signed application once", () => {
    const l = readFileSync("src/services/lenders/loadPackageInputs.ts", "utf8");
    expect(l).toContain("!isAppCopy(p.filename) && !filed.has(p.filename)");
    expect(l).toContain("documents: docsOut");
  });
});
