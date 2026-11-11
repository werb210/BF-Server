// KS_SERVER_LICENSEE_DOCUMENTS - fills a licensee's own document with a file's values and makes it ready to sign.
//   Fillable PDF: each field gets the value of what it was matched to (or the client's answer to the extra question
//   made for it); check boxes tick on yes/true/x; the form is flattened. The form's own signature boxes carry the
//   SignNow tags for the signers; a form with no signature box gets a signature page at the end.
//   Word: the {{fields}} are merged, the result is laid out as a PDF and a signature page is added.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { fillAcroForm, type FieldMap, type SignTag } from "../signnow/sba/fillAcroForm.js";
import { docxBlocks, mergeDocx, renderContractPdf } from "../brokerTools/docx.js";
import { questionKey, type MatchedField } from "./match.js";
import type { DocFormat } from "./readFields.js";

export type FillableDoc = { name: string; format: DocFormat; file: Buffer; fields: MatchedField[] };
export type SignerRole = { role: string; name: string; email: string };

const YES = /^(y|yes|true|x|on|1|checked)$/i;
const OWNER2 = /\b(co[\s-]?applicant|co[\s-]?borrower|owner\s*2|second|partner|guarantor\s*2|2nd)\b/i;

/** The value each document field gets, by the document's own field name. */
export function fieldValues(fields: MatchedField[], values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "signature") continue;
    const v = f.mapped_to ? values[f.mapped_to] : values[`extra.${questionKey(f.name)}`];
    if (v !== undefined && v !== null && String(v) !== "") out[f.name] = String(v);
  }
  return out;
}

async function appendSignaturePage(pdf: Uint8Array, signers: SignerRole[]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdf);
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let y = 792 - 72;
  page.drawText("Signatures", { x: 54, y, size: 14, font: B });
  y -= 50;
  for (const s of signers) {
    page.drawText(`${s.name || s.role}`.replace(/[^\x20-\x7e]/g, ""), { x: 54, y: y + 24, size: 10, font: B });
    page.drawText(`{{t:s;r:y;o:"${s.role}";w:200;h:30;}}`, { x: 56, y: y + 6, size: 6, font: F, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: 54, y: y + 2 }, end: { x: 294, y: y + 2 }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`{{t:t;r:y;o:"${s.role}";l:"Date";w:110;h:16;}}`, { x: 356, y: y + 6, size: 6, font: F, color: rgb(1, 1, 1) });
    page.drawLine({ start: { x: 354, y: y + 2 }, end: { x: 474, y: y + 2 }, thickness: 0.7, color: rgb(0.3, 0.3, 0.3) });
    page.drawText("Signature", { x: 54, y: y - 10, size: 8, font: F });
    page.drawText("Date", { x: 354, y: y - 10, size: 8, font: F });
    y -= 90;
  }
  return doc.save();
}

/** The filled document as a PDF ready for SignNow. */
export async function fillDocument(doc: FillableDoc, values: Record<string, string>, signers: SignerRole[], footer: string): Promise<Uint8Array> {
  const byName = fieldValues(doc.fields, values);
  if (doc.format === "pdf_form") {
    const map: FieldMap = {};
    for (const f of doc.fields) {
      const v = byName[f.name];
      if (v === undefined) continue;
      map[f.name] = f.type === "checkbox" ? YES.test(v.trim()) : v;
    }
    // Signature boxes: a box whose label names the second owner goes to the second signer, the rest to the first.
    const sigs = doc.fields.filter((f) => f.type === "signature");
    const tags: SignTag[] = signers.length ? sigs.map((f) => ({ field: f.name, type: "s" as const, role: (OWNER2.test(f.label) || OWNER2.test(f.name)) && signers[1] ? signers[1].role : signers[0].role })) : [];
    const filled = await fillAcroForm(new Uint8Array(doc.file), map, tags);
    const covered = new Set(tags.map((t) => t.role));
    const missing = signers.filter((s) => !covered.has(s.role));
    return missing.length ? appendSignaturePage(filled, missing) : filled;
  }
  if (doc.format === "docx_fields") {
    const merged = mergeDocx(doc.file, byName).docx;
    return renderContractPdf(docxBlocks(merged), { title: doc.name, signers: signers.map((s) => ({ name: s.name || s.role, email: s.email, role: s.role })), footer });
  }
  throw new Error("This document has no fill-in fields.");
}
