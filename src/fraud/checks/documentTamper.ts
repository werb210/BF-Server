// BF_SERVER_v846_FRAUD - check 1: document tamper scan. One red / amber / green badge per uploaded file, with reasons.
// Builds on the existing metadata scan (src/services/documents/fraudSignals.ts) and adds what is inside the file:
// mixed or re-embedded fonts, text drawn over a scanned page, page images saved at different quality, and photo
// editors named in image metadata.
import { SUSPECT_PRODUCERS, type DocKind, type PdfMeta } from "../../services/documents/fraudSignals.js";
import type { PdfStructure } from "../pdfStructure.js";
import type { JpegInfo } from "../imageHash.js";
import { result, type CheckResult, type Reason } from "../types.js";

export type DocKindPlus = DocKind | "id" | "void_cheque";

export const IMAGE_EDITORS = ["photoshop", "gimp", "canva", "pixelmator", "affinity", "picsart", "paint.net", "snapseed", "lightroom", "fotor", "photopea", "illustrator"];

/** From the document category, as the existing classifier, plus IDs and void cheques. */
export function classifyKindPlus(category: string | null | undefined, base: (c: string | null | undefined) => DocKind): DocKindPlus {
  const c = String(category ?? "").toLowerCase();
  if (/void|cheque|check\b|pad\b|direct deposit/.test(c)) return "void_cheque";
  if (/\bid\b|identification|driver|licen[cs]e|passport|photo_id|government/.test(c)) return "id";
  // Category keys use underscores (t2_tax_return); the base classifier's word boundaries need spaces.
  return base(c.replace(/[_-]+/g, " "));
}

export type TamperInput = {
  kind: DocKindPlus;
  fileType: "pdf" | "jpeg" | "png" | "other";
  meta: PdfMeta | null;
  structure: PdfStructure | null;
  jpeg: JpegInfo | null;
  pngSoftware: string | null;
};

const sourceDoc = (k: DocKindPlus) => k === "bank_statement" || k === "tax_return";

export function evaluateDocumentTamper(i: TamperInput): CheckResult {
  const reasons: Reason[] = [];
  const strict = sourceDoc(i.kind);
  const what = i.kind === "bank_statement" ? "bank statement" : i.kind === "tax_return" ? "tax document" : i.kind === "id" ? "ID" : i.kind === "void_cheque" ? "void cheque" : "document";

  if (i.fileType === "pdf" && i.meta) {
    const prod = `${i.meta.producer ?? ""} ${i.meta.creator ?? ""}`.toLowerCase();
    const hit = SUSPECT_PRODUCERS.find((p) => prod.includes(p));
    if (hit && strict) reasons.push({ code: "editor_producer", severity: "red", text: `This ${what} was produced by editing software ("${hit}"). Banks and the CRA do not produce statements with it.` });
    else if (hit && (i.kind === "id" || i.kind === "void_cheque")) reasons.push({ code: "editor_producer", severity: "amber", text: `This ${what} was saved with editing software ("${hit}").` });
    if (i.meta.incrementalSaves > 1) {
      reasons.push(strict
        ? { code: "incremental_saves", severity: "amber", text: `The file was saved ${i.meta.incrementalSaves} times. A statement straight from the bank is saved once.` }
        : { code: "incremental_saves", severity: "info", text: `The file was saved ${i.meta.incrementalSaves} times.` });
    }
    if (i.meta.createdAt != null && i.meta.modifiedAt != null && i.meta.modifiedAt - i.meta.createdAt > 60_000) {
      const mins = Math.round((i.meta.modifiedAt - i.meta.createdAt) / 60_000);
      reasons.push(strict
        ? { code: "modified_after_create", severity: "amber", text: `The file was changed ${mins} minute(s) after it was created.` }
        : { code: "modified_after_create", severity: "info", text: `The file was changed ${mins} minute(s) after it was created.` });
    }
    if (!i.meta.parsed) reasons.push({ code: "unreadable_pdf", severity: "info", text: "The PDF could not be opened for a full scan (it may be password protected). Review it by eye." });
  }

  const s = i.structure;
  if (i.fileType === "pdf" && s?.parsed) {
    if (strict && s.duplicateSubsetFonts.length) {
      reasons.push({ code: "font_reembedded", severity: "amber", text: `The same font (${s.duplicateSubsetFonts.slice(0, 2).join(", ")}) is embedded more than once, which happens when text is edited or added later.` });
    }
    if (strict && s.fonts.length > 6) {
      reasons.push({ code: "many_fonts", severity: "amber", text: `The ${what} uses ${s.fonts.length} different fonts; statements from a bank normally use two or three.` });
    }
    if (s.pagesWithTextOverImage.length) {
      reasons.push({ code: "text_over_image", severity: strict ? "amber" : "info", text: `Typed text sits on top of a scanned page image (page ${s.pagesWithTextOverImage.slice(0, 5).join(", ")}), which is how scanned figures get covered up.` });
    }
    if (s.jpegQualities.length >= 2) {
      const spread = Math.max(...s.jpegQualities) - Math.min(...s.jpegQualities);
      if (spread >= 15) reasons.push({ code: "mixed_compression", severity: strict || i.kind === "id" ? "amber" : "info", text: `The page images were saved at different quality levels (${Math.min(...s.jpegQualities)} to ${Math.max(...s.jpegQualities)}), so one page may have been replaced.` });
    }
  }

  const imgSoftware = (i.jpeg?.software ?? i.pngSoftware ?? "").toLowerCase();
  if (i.fileType === "jpeg" || i.fileType === "png") {
    const editor = IMAGE_EDITORS.find((e) => imgSoftware.includes(e));
    if (editor) {
      reasons.push({ code: "image_editor", severity: strict || i.kind === "id" || i.kind === "void_cheque" ? "red" : "amber", text: `The picture was last saved by photo-editing software ("${editor}").` });
    } else if (i.jpeg?.photoshop) {
      reasons.push({ code: "photoshop_marker", severity: "amber", text: "The picture carries an Adobe Photoshop marker, so it went through an image editor." });
    }
  }

  const ambers = reasons.filter((r) => r.severity === "amber").length;
  if (strict && ambers >= 3 && !reasons.some((r) => r.severity === "red")) {
    reasons.unshift({ code: "several_signs", severity: "red", text: `Several signs of editing were found together on this ${what}.` });
  }
  if (!reasons.some((r) => r.severity !== "info")) {
    reasons.push({ code: "no_signs", severity: "info", text: i.fileType === "other" ? "This file type cannot be scanned for editing; review it by eye." : "No signs of editing were found." });
  }
  return result(reasons, {
    kind: i.kind, file_type: i.fileType,
    fonts: s?.fonts.length ?? null, scanned_pages: s?.scannedPages ?? null, pages: s?.pages ?? null,
  });
}
