// KS_SERVER_LICENSEE_DOCUMENTS - the fill-in fields on a licensee's own document.
//   A fillable PDF: its form fields (text, check boxes, choices, signature boxes), labelled with the field's tooltip
//   when it has one, otherwise its name made readable.
//   A Word file: its {{merge fields}}.
// A document with neither cannot be filled automatically; the licensee is told how to make it fillable.
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFName, PDFOptionList, PDFRadioGroup, PDFSignature, PDFString, PDFHexString } from "pdf-lib";
import { templateFields } from "../brokerTools/docx.js";

export type DocFormat = "pdf_form" | "docx_fields" | "none";
export type DocFieldType = "text" | "checkbox" | "choice" | "signature";
export type DocField = { name: string; label: string; type: DocFieldType; options?: string[] };

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function kindOfFile(buffer: Buffer, fileName: string): "pdf" | "docx" | "other" {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (buffer.subarray(0, 2).toString("latin1") === "PK" && (/\.docx$/i.test(fileName) || buffer.includes(Buffer.from("word/")))) return "docx";
  return "other";
}

/** "BusinessLegalName" / "business_legal_name" / "txtBusName[0]" -> "Business legal name". */
export function readableName(name: string): string {
  const last = name.split(".").pop() ?? name;
  const t = last
    .replace(/\[\d+\]/g, "")
    .replace(/^(txt|text|fld|field|chk|cb|cbx|check|rb|radio|dd|ddl|sig)(?=[A-Z_\d])/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : name;
}

function tooltip(field: { acroField: { dict: { get: (n: PDFName) => unknown } } }): string | null {
  const tu = field.acroField.dict.get(PDFName.of("TU"));
  if (tu instanceof PDFString || tu instanceof PDFHexString) { const v = tu.decodeText().trim(); return v || null; }
  return null;
}

export async function readDocumentFields(buffer: Buffer, fileName: string): Promise<{ format: DocFormat; fields: DocField[] }> {
  const kind = kindOfFile(buffer, fileName);
  if (kind === "pdf") {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const fields: DocField[] = [];
    for (const f of doc.getForm().getFields()) {
      const name = f.getName();
      const label = tooltip(f as any) ?? readableName(name);
      if (f instanceof PDFSignature) fields.push({ name, label, type: "signature" });
      else if (f instanceof PDFCheckBox) fields.push({ name, label, type: "checkbox" });
      else if (f instanceof PDFRadioGroup) fields.push({ name, label, type: "choice", options: f.getOptions() });
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) fields.push({ name, label, type: "choice", options: f.getOptions() });
      else fields.push({ name, label, type: "text" });
    }
    return { format: fields.length ? "pdf_form" : "none", fields };
  }
  if (kind === "docx") {
    const names = templateFields(buffer);
    const fields: DocField[] = names.map((name) => ({ name, label: readableName(name.replace(/\./g, " ")), type: /sign(ature)?$/i.test(name) ? "signature" : "text" }));
    return { format: fields.length ? "docx_fields" : "none", fields };
  }
  return { format: "none", fields: [] };
}
