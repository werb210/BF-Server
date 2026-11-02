// BF_SERVER_v848_OFFICE_DOCS - Word / Excel / CSV / text files become text the OCR model can read.
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { documentToText, isPermanentOcrError, MAX_OCR_TEXT_CHARS, OcrPermanentError, textDocumentKind, xlsxToText } from "../officeText.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function makeDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

export async function makeXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file("xl/workbook.xml", '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="P&amp;L" sheetId="1" r:id="rId1"/><sheet name="Balance Sheet" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file("xl/_rels/workbook.xml.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="ws" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId3" Type="ss" Target="sharedStrings.xml"/></Relationships>');
  zip.file("xl/sharedStrings.xml", '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Revenue</t></si><si><r><t>Net </t></r><r><t>income</t></r><rPh><t>x</t></rPh></si><si><t>Cash &amp; equivalents</t></si></sst>');
  zip.file("xl/worksheets/sheet1.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="20"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>1250000</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"/><c r="C2"><f>C1*0.1</f><v>125000</v></c><c r="D2" t="b"><v>1</v></c></row><row r="3"/></sheetData></worksheet>');
  zip.file("xl/worksheets/sheet2.xml", '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="inlineStr"><is><t>$40,000 &lt;CAD&gt;</t></is></c></row></sheetData></worksheet>');
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("documentToText", () => {
  it("reads a Word document", async () => {
    const r = await documentToText(await makeDocx(["Business plan", "Revenue: $1,250,000 & growing"]), DOCX, "plan.docx");
    expect(r.kind).toBe("docx");
    expect(r.text).toContain("Business plan");
    expect(r.text).toContain("Revenue: $1,250,000 & growing");
    expect(r.truncated).toBe(false);
  });

  it("reads every sheet of an Excel workbook, in workbook order, cells tab-separated", async () => {
    const text = await xlsxToText(await makeXlsx());
    expect(text).toBe("Sheet: P&L\nRevenue\t\t1250000\nNet income\t\t125000\tTRUE\n\nSheet: Balance Sheet\nCash & equivalents\t$40,000 <CAD>");
    const r = await documentToText(await makeXlsx(), XLSX, "financials.xlsx");
    expect(r.kind).toBe("xlsx");
    expect(r.text).toContain("Net income\t\t125000");
  });

  it("reads CSV and plain text, trusting the file name over a Windows .csv MIME type", async () => {
    const csv = await documentToText(Buffer.from("﻿month,deposits\r\nJan,1000\r\n"), "application/vnd.ms-excel", "bank.csv");
    expect(csv).toMatchObject({ kind: "csv", text: "month,deposits\nJan,1000" });
    const txt = await documentToText(Buffer.from("hello"), "text/plain");
    expect(txt).toMatchObject({ kind: "text", text: "hello" });
  });

  it("recognises a Word file sent as application/octet-stream by what is inside it", async () => {
    expect(await textDocumentKind(await makeDocx(["x"]), "application/octet-stream", "upload")).toBe("docx");
    expect(await textDocumentKind(await makeXlsx(), "application/octet-stream")).toBe("xlsx");
  });

  it("cuts very long text and says so", async () => {
    const r = await documentToText(Buffer.from("a".repeat(MAX_OCR_TEXT_CHARS + 500)), "text/plain", "big.txt");
    expect(r.truncated).toBe(true);
    expect(r.originalChars).toBe(MAX_OCR_TEXT_CHARS + 500);
    expect(r.text.startsWith("a".repeat(MAX_OCR_TEXT_CHARS))).toBe(true);
    expect(r.text).toMatch(/\[\.\.\. 500 more characters not shown\]$/);
  });

  it("fails permanently for types it cannot read, broken files and empty files", async () => {
    for (const [buf, mime, name, msg] of [
      [Buffer.from("\xD0\xCF\x11\xE0", "latin1"), "application/msword", "old.doc", /^unsupported_mime_type:application\/msword/],
      [Buffer.from("\xD0\xCF\x11\xE0", "latin1"), "application/vnd.ms-excel", "old.xls", /^unsupported_mime_type/],
      [Buffer.from("PK\x03\x04garbage"), DOCX, "broken.docx", /^document_unreadable:docx/],
      [Buffer.from("  \n "), "text/plain", "blank.txt", /^document_has_no_text/],
    ] as const) {
      const err = await documentToText(buf, mime, name).catch((e) => e);
      expect(err).toBeInstanceOf(OcrPermanentError);
      expect(String(err.message)).toMatch(msg);
      expect(isPermanentOcrError(err)).toBe(true);
    }
  });

  it("does not treat network or model errors as permanent", () => {
    expect(isPermanentOcrError(new Error("ETIMEDOUT"))).toBe(false);
    expect(isPermanentOcrError(new Error("openai_ocr_failed:500:oops"))).toBe(false);
    expect(isPermanentOcrError(new Error("unsupported_mime_type"))).toBe(true);
  });
});
