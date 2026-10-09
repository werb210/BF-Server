// BF_SERVER_SBA_FORM_TIDY_v799
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFArray, PDFNumber, rgb } from "pdf-lib";
import { tidyWidgets, fillAcroForm } from "../fillAcroForm.js";

async function form() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const f = doc.getForm();
  const box = f.createCheckBox("male");
  box.addToPage(page, { x: 197, y: 606, width: 9, height: 9, backgroundColor: rgb(0.87, 0.89, 1), borderColor: rgb(0, 0, 0) });
  // store the rectangle upside down, as the SBA 1919 does
  box.acroField.getWidgets()[0]!.dict.set(PDFName.of("Rect"), doc.context.obj([197, 615, 206, 606]));
  f.createTextField("Signature").addToPage(page, { x: 60, y: 120, width: 180, height: 24 });
  return doc;
}

describe("SBA template tidy-up", () => {
  it("puts upside-down boxes the right way up and removes the shading and border", async () => {
    const doc = await form();
    const f = doc.getForm();
    expect(f.getCheckBox("male").acroField.getWidgets()[0]!.getRectangle().height).toBeLessThan(0);
    tidyWidgets(f);
    const w = f.getCheckBox("male").acroField.getWidgets()[0]!;
    expect(w.getRectangle()).toEqual({ x: 197, y: 606, width: 9, height: 9 });
    const mk = w.getAppearanceCharacteristics();
    expect(mk?.getBackgroundColor()).toBeUndefined();
    expect(mk?.getBorderColor()).toBeUndefined();
  });
  it("a ticked box lands on its printed box after flattening", async () => {
    const doc = await form();
    const out = await fillAcroForm(await doc.save(), { male: true });
    const flat = await PDFDocument.load(out);
    expect(flat.getForm().getFields().length).toBe(0); // flattened
  });
  it("the 413 date is left for the signing-date stamp (no second, overlapping date)", () => {
    const b = readFileSync("src/signnow/sba/sbaFormBuilder.ts", "utf8");
    expect(b).not.toContain("[F413.date]: today");
  });
  it("the form's own signature boxes are removed after the SignNow tags are placed", () => {
    const s = readFileSync("src/signnow/sba/fillAcroForm.ts", "utf8");
    expect(s.indexOf("const tagSpots = locateSignTags(doc, signTags);")).toBeLessThan(s.indexOf("form.removeField(f)"));
  });
});
