// BF_SERVER_v846_FRAUD - check 1 (document tamper scan) and the fingerprints behind check 4, on real files.
import { describe, expect, it } from "vitest";
import { analyzePdfStructure, scanContentOps } from "../pdfStructure.js";
import { dHash, decodeImage, hamming, informativeHash, isScreenSize, jpegInfo, pngInfo, qualityFromTable, NEAR_DUPLICATE_BITS } from "../imageHash.js";
import { classifyKindPlus, evaluateDocumentTamper } from "../checks/documentTamper.js";
import { classifyDocKind, extractPdfMeta } from "../../services/documents/fraudSignals.js";
import { makeJpeg, makePng, scannedPdf, textPdf, withExif } from "./fixtures.js";

describe("perceptual hashes", () => {
  it("the same picture saved at another quality or size stays within a few bits; a different picture does not", () => {
    const a = dHash(decodeImage(makeJpeg(600, 400, 90))!);
    const b = dHash(decodeImage(makeJpeg(600, 400, 40))!);
    const c = dHash(decodeImage(makeJpeg(300, 200, 70))!);
    const other = dHash(decodeImage(makeJpeg(600, 400, 90, 1))!);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(a, b)).toBeLessThanOrEqual(NEAR_DUPLICATE_BITS);
    expect(hamming(a, c)).toBeLessThanOrEqual(NEAR_DUPLICATE_BITS);
    expect(hamming(a, other)).toBeGreaterThan(NEAR_DUPLICATE_BITS);
    expect(informativeHash(a)).toBe(true);
    expect(informativeHash("0000000000000000")).toBe(false);
  });

  it("decodes PNG too and reads its Software text", () => {
    const png = makePng(500, 300, "Adobe Photoshop 25.0");
    expect(decodeImage(png)?.width).toBe(500);
    expect(pngInfo(png)).toEqual({ software: "Adobe Photoshop 25.0", width: 500, height: 300 });
  });

  it("reads EXIF software / make and estimates JPEG quality", () => {
    const j = withExif(makeJpeg(400, 300, 50), { software: "Adobe Photoshop 2024", make: "Apple" });
    const info = jpegInfo(j)!;
    expect(info.software).toBe("Adobe Photoshop 2024");
    expect(info.make).toBe("Apple");
    expect(info.width).toBe(400);
    expect(Math.abs((info.quality ?? 0) - 50)).toBeLessThanOrEqual(3);
    expect(Math.abs((jpegInfo(makeJpeg(400, 300, 92))!.quality ?? 0) - 92)).toBeLessThanOrEqual(3);
    expect(qualityFromTable(new Array(64).fill(1))).toBe(100);
  });

  it("knows phone and monitor screen sizes in either orientation", () => {
    expect(isScreenSize(1170, 2532)).toBe(true);
    expect(isScreenSize(2532, 1170)).toBe(true);
    expect(isScreenSize(4032, 3024)).toBe(false);
  });
});

describe("PDF structure", () => {
  it("lists fonts and finds no scan in a text PDF", async () => {
    const s = await analyzePdfStructure(await textPdf({ fonts: 2 }));
    expect(s.parsed).toBe(true);
    expect(s.fonts).toEqual(expect.arrayContaining(["Helvetica", "Courier"]));
    expect(s.scannedPages).toBe(0);
    expect(s.pagesWithTextOverImage).toEqual([]);
  });

  it("finds typed text over a scanned page, page image quality and the images for hashing", async () => {
    const s = await analyzePdfStructure(await scannedPdf({ pages: [{ quality: 85 }, { quality: 40, overlay: "12,500.00" }] }));
    expect(s.scannedPages).toBe(2);
    expect(s.pagesWithTextOverImage).toEqual([2]);
    expect(s.jpegQualities).toHaveLength(2);
    expect(Math.max(...s.jpegQualities) - Math.min(...s.jpegQualities)).toBeGreaterThanOrEqual(30);
    expect(s.images).toHaveLength(2);
  });

  it("counts invisible OCR text separately from visible text, ignoring operators inside strings", () => {
    const ops = scanContentOps("q /Im1 Do Q BT 3 Tr (hello Tj) Tj (x) Tj ET BT 0 Tr (99.00) Tj ET", new Set(["Im1"]));
    expect(ops).toEqual({ visibleText: 1, invisibleText: 2, largeImageDraws: 1 });
  });

  it("a non-PDF is not parsed", async () => {
    expect((await analyzePdfStructure(Buffer.from("hello"))).parsed).toBe(false);
  });
});

describe("check 1 evaluation", () => {
  const kind = (c: string) => classifyKindPlus(c, classifyDocKind);

  it("classifies IDs and void cheques before the bank / tax rules", () => {
    expect(kind("void_cheque")).toBe("void_cheque");
    expect(kind("Driver's licence")).toBe("id");
    expect(kind("bank_statements_6_months")).toBe("bank_statement");
    expect(kind("t2_tax_return")).toBe("tax_return");
  });

  it("a bank statement made with an editor is red; a clean one is green with a reason", async () => {
    const edited = await textPdf({ producer: "iLovePDF" });
    const r = evaluateDocumentTamper({ kind: "bank_statement", fileType: "pdf", meta: await extractPdfMeta(edited), structure: await analyzePdfStructure(edited), jpeg: null, pngSoftware: null });
    expect(r.status).toBe("red");
    expect(r.reasons[0]!.code).toBe("editor_producer");
    const clean = await textPdf({ producer: "Bank Statement Generator 4.2" });
    const g = evaluateDocumentTamper({ kind: "bank_statement", fileType: "pdf", meta: await extractPdfMeta(clean), structure: await analyzePdfStructure(clean), jpeg: null, pngSoftware: null });
    expect(g.status).toBe("green");
    expect(g.reasons.map((x) => x.code)).toEqual(["no_signs"]);
  });

  it("several amber signs on a bank statement add up to red", async () => {
    const buf = await scannedPdf({ pages: [{ quality: 90 }, { quality: 45, overlay: "Balance 9,999.00" }] });
    const meta = { ...(await extractPdfMeta(buf)), incrementalSaves: 3 };
    const r = evaluateDocumentTamper({ kind: "bank_statement", fileType: "pdf", meta, structure: await analyzePdfStructure(buf), jpeg: null, pngSoftware: null });
    expect(r.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["incremental_saves", "text_over_image", "mixed_compression", "several_signs"]));
    expect(r.status).toBe("red");
  });

  it("too many fonts is amber on a statement but not mentioned on other documents", async () => {
    const buf = await textPdf({ fonts: 8, lines: ["a", "b", "c", "d", "e", "f", "g", "h"] });
    const s = await analyzePdfStructure(buf);
    const meta = await extractPdfMeta(buf);
    expect(evaluateDocumentTamper({ kind: "bank_statement", fileType: "pdf", meta, structure: s, jpeg: null, pngSoftware: null }).reasons.some((r) => r.code === "many_fonts")).toBe(true);
    expect(evaluateDocumentTamper({ kind: "other", fileType: "pdf", meta, structure: s, jpeg: null, pngSoftware: null }).status).toBe("green");
  });

  it("an ID photo saved by Photoshop is red; an unscannable file type says so", () => {
    const j = withExif(makeJpeg(), { software: "Adobe Photoshop 2024" });
    expect(evaluateDocumentTamper({ kind: "id", fileType: "jpeg", meta: null, structure: null, jpeg: jpegInfo(j), pngSoftware: null }).status).toBe("red");
    const other = evaluateDocumentTamper({ kind: "other", fileType: "other", meta: null, structure: null, jpeg: null, pngSoftware: null });
    expect(other.status).toBe("green");
    expect(other.reasons[0]!.text).toMatch(/cannot be scanned/);
  });
});
