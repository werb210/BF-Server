// BF_SERVER_SBA_SIGN_TAGS_v791
import { describe, it, expect } from "vitest";
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from "pdf-lib";
import { fillAcroForm, signTagText } from "../fillAcroForm.js";
import { zip5 } from "../sbaFormBuilder.js";

async function template(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("Name").addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  form.createTextField("Signature").addToPage(page, { x: 60, y: 120, width: 180, height: 24 });
  form.createTextField("Initials").addToPage(page, { x: 400, y: 300, width: 40, height: 16 });
  return doc.save();
}
async function pageText(bytes: Uint8Array, index: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPages()[index]!.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  let out = "";
  for (const r of refs) {
    const s = doc.context.lookup(r as any) as PDFRawStream;
    const filter = s.dict.get(PDFName.of("Filter"));
    const raw = Buffer.from(s.contents);
    out += (filter ? inflateSync(raw) : raw).toString("latin1");
  }
  return out;
}
const hex = (s: string) => Buffer.from(s, "latin1").toString("hex").toUpperCase();

describe("SBA forms carry SignNow signer tags", () => {
  it("draws a signature and an initials tag for the owner on the page that holds the boxes", async () => {
    const out = await fillAcroForm(await template(), { Name: "Todd" }, [
      { field: "Signature", type: "s", role: "Owner 1" },
      { field: "Initials", type: "i", role: "Owner 1" },
    ]);
    const text = (await pageText(out, 1)).toUpperCase();
    expect(text).toContain(hex(signTagText({ field: "Signature", type: "s", role: "Owner 1" }, 181, 25)));
    expect(text).toContain(hex(signTagText({ field: "Initials", type: "i", role: "Owner 1" }, 41, 17)));
  });
  it("still gives SignNow a signer when the signature box cannot be found", async () => {
    const out = await fillAcroForm(await template(), {}, [{ field: "No Such Box", type: "s", role: "Owner 2" }]);
    expect((await pageText(out, 1)).toUpperCase()).toContain(hex('o:"Owner 2"'));
  });
  it("uses the tag syntax SignNow reads", () => {
    expect(signTagText({ field: "x", type: "s", role: "Owner 1" }, 180, 24)).toBe('{{t:s;r:y;o:"Owner 1";w:180;h:24;}}');
  });
  it("every SBA form now names its signer", () => {
    const b = readFileSync("src/signnow/sba/sbaFormBuilder.ts", "utf8");
    expect((b.match(/return fillAcroForm\(tpl, values, \[/g) ?? []).length).toBe(4);
  });
  it("fits a ZIP+4 into the 4506-C's five-character box", () => {
    expect(zip5("12344-5332")).toBe("12344");
    expect(zip5("T6X 1G9")).toBe("T6X 1G9");
  });
});
