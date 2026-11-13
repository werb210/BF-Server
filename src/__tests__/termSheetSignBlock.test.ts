// A term sheet made from the brokerage's Word template has a visible place for the client to sign and date, and is
// marked so Send for signature does not stamp a second, floating signature box on it.
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { dateLine, hasSigningTags, renderContractPdf, signatureLine, type Block } from "../brokerTools/docx.js";

const para = (text: string): Block => ({ kind: "para", text });
const client = { name: "Sam Carter", email: "", role: "Client" };
const pages = async (pdf: Uint8Array) => (await PDFDocument.load(pdf)).getPageCount();

describe("recognising a place to sign", () => {
  it("accepts the usual ways a signature line is typed", () => {
    expect(signatureLine("Signature: ______________________   Date: ____________")).toEqual({ date: true });
    expect(signatureLine("Signature ______________________")).toEqual({ date: false });
    expect(signatureLine("Signed by: __________")).toEqual({ date: false });
    expect(signatureLine("Sign here ______")).toEqual({ date: false });
  });
  it("leaves ordinary text alone", () => {
    expect(signatureLine("By signing, Sam Carter accepts the terms above.")).toBeNull();
    expect(signatureLine("The signature of each principal is required.")).toBeNull();
    expect(signatureLine("Name: ______________")).toBeNull();
  });
  it("knows a date-only line", () => {
    expect(dateLine("Date: ____________")).toBe(true);
    expect(dateLine("Dated ______")).toBe(true);
    expect(dateLine("Date of the loan: 2026-12-15")).toBe(false);
  });
});

describe("the term sheet PDF", () => {
  it("signs on the template's own signature line, on the same page, and is marked as ready to sign", async () => {
    const pdf = await renderContractPdf([para("Terms"), para("Signature: ______________________   Date: ____________"), para("Name: Sam Carter")],
      { title: "Term sheet", signers: [client], footer: "x", inlineSignatures: true });
    expect(await pages(pdf)).toBe(1);
    expect(await hasSigningTags(pdf)).toBe(true);
  });
  it("adds a place to sign after the text when the template has none, without a page of its own", async () => {
    const pdf = await renderContractPdf([para("Terms"), para("No signature line here.")], { title: "Term sheet", signers: [client], footer: "x", inlineSignatures: true });
    expect(await pages(pdf)).toBe(1);
    expect(await hasSigningTags(pdf)).toBe(true);
  });
  it("moves the place to sign to a new page only when the page is full", async () => {
    const long = Array.from({ length: 46 }, (_, i) => para(`Line ${i + 1} of the terms.`));
    const pdf = await renderContractPdf(long, { title: "Term sheet", signers: [client], footer: "x", inlineSignatures: true });
    expect(await pages(pdf)).toBe(2);
  });
  it("contracts keep their signature page at the end", async () => {
    const pdf = await renderContractPdf([para("Agreement text")], { title: "Contract", signers: [{ name: "A", email: "a@example.com", role: "Signer 1" }], footer: "x" });
    expect(await pages(pdf)).toBe(2);
    expect(await hasSigningTags(pdf)).toBe(true);
  });
  it("a document with no signers is not marked, so a lender's own PDF still gets its signature box when sent", async () => {
    const pdf = await renderContractPdf([para("Text")], { title: "Invoice", signers: [], footer: "x" });
    expect(await hasSigningTags(pdf)).toBe(false);
    const other = await (await PDFDocument.create()).save();
    expect(await hasSigningTags(other)).toBe(false);
    expect(await hasSigningTags(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
