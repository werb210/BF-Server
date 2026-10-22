// BF_SERVER_v846_FRAUD - what is inside a PDF beyond its metadata: the fonts it embeds, whether visible text was drawn
// on top of a scanned page image, and the compression of its page images. Read-only and bounded (40 pages, 2 MB of
// page content each), so a hostile file cannot stall the worker.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { jpegInfo } from "./imageHash.js";

export type PdfImage = { width: number; height: number; jpeg: Buffer };

export type PdfStructure = {
  parsed: boolean;
  pages: number;
  /** Base font names (subset prefix removed), sorted. */
  fonts: string[];
  /** Base fonts embedded under two or more different subset prefixes (e.g. ABCDEF+Arial and GHIJKL+Arial). */
  duplicateSubsetFonts: string[];
  /** 1-based pages where visible text was drawn over a page-sized scanned image. */
  pagesWithTextOverImage: number[];
  scannedPages: number;
  /** Estimated JPEG quality of each large page image. */
  jpegQualities: number[];
  /** Large JPEG page images (for perceptual hashing), at most 12. */
  images: PdfImage[];
};

const MAX_PAGES = 40;
const MAX_CONTENT = 2 * 1024 * 1024;
const LARGE_IMAGE_PIXELS = 400 * 400;

function num(v: unknown): number {
  return v instanceof PDFNumber ? v.asNumber() : 0;
}

function filterNames(dict: PDFDict): string[] {
  const f = dict.get(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.asString()];
  if (f instanceof PDFArray) return f.asArray().filter((x): x is PDFName => x instanceof PDFName).map((x) => x.asString());
  return [];
}

function decodeContent(doc: PDFDocument, contents: unknown): string {
  const streams: PDFRawStream[] = [];
  const add = (o: unknown) => {
    const v = o instanceof PDFRef ? doc.context.lookup(o) : o;
    if (v instanceof PDFRawStream) streams.push(v);
  };
  if (contents instanceof PDFArray) contents.asArray().forEach(add);
  else add(contents);
  let out = "";
  for (const s of streams) {
    try {
      const bytes = decodePDFRawStream(s).decode();
      out += Buffer.from(bytes.subarray(0, MAX_CONTENT - out.length)).toString("latin1") + "\n";
    } catch {
      /* an undecodable stream contributes nothing */
    }
    if (out.length >= MAX_CONTENT) break;
  }
  return out;
}

/** Counts visible and invisible (render mode 3) text-showing operators and image draws in a content stream. */
export function scanContentOps(content: string, largeImageNames: Set<string>): { visibleText: number; invisibleText: number; largeImageDraws: number } {
  // Remove string operands first so text that happens to read "Tj" or "Do" is not taken for an operator.
  const stripped = content
    .replace(/\((?:\\.|[^\\)])*\)/g, "()")
    .replace(/<[0-9a-fA-F\s]*>/g, "<>");
  let tr = 0, visibleText = 0, invisibleText = 0, largeImageDraws = 0;
  const re = /(-?\d+)\s+Tr\b|\b(Tj|TJ)\b|(?:^|\s)(['"])(?=\s|$)|\/([^\s/<>[\]()]+)\s+Do\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    if (m[1] !== undefined) tr = Number(m[1]);
    else if (m[2] || m[3]) { if (tr === 3) invisibleText++; else visibleText++; }
    else if (m[4] && largeImageNames.has(m[4])) largeImageDraws++;
  }
  return { visibleText, invisibleText, largeImageDraws };
}

export async function analyzePdfStructure(buffer: Buffer): Promise<PdfStructure> {
  const empty: PdfStructure = { parsed: false, pages: 0, fonts: [], duplicateSubsetFonts: [], pagesWithTextOverImage: [], scannedPages: 0, jpegQualities: [], images: [] };
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) return empty;
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return empty;
  }
  const prefixesByFont = new Map<string, Set<string>>();
  const pagesWithTextOverImage: number[] = [];
  const jpegQualities: number[] = [];
  const images: PdfImage[] = [];
  const seenImages = new Set<string>();
  let scannedPages = 0;
  const pages = doc.getPages();
  for (let p = 0; p < Math.min(pages.length, MAX_PAGES); p++) {
    try {
      const node = pages[p]!.node;
      const resources = node.Resources();
      const fontDict = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
      for (const [, ref] of fontDict?.entries() ?? []) {
        const fd = ref instanceof PDFRef ? doc.context.lookupMaybe(ref, PDFDict) : ref instanceof PDFDict ? ref : undefined;
        const base = fd?.get(PDFName.of("BaseFont"));
        if (!(base instanceof PDFName)) continue;
        const raw = base.decodeText();
        const mm = raw.match(/^([A-Z]{6})\+(.+)$/);
        const name = (mm ? mm[2]! : raw).trim();
        if (!prefixesByFont.has(name)) prefixesByFont.set(name, new Set());
        if (mm) prefixesByFont.get(name)!.add(mm[1]!);
      }
      const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
      const large = new Set<string>();
      for (const [key, ref] of xobjects?.entries() ?? []) {
        const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
        if (!(obj instanceof PDFRawStream)) continue;
        const sub = obj.dict.get(PDFName.of("Subtype"));
        if (!(sub instanceof PDFName) || sub.asString() !== "/Image") continue;
        const w = num(obj.dict.get(PDFName.of("Width"))), h = num(obj.dict.get(PDFName.of("Height")));
        if (w * h < LARGE_IMAGE_PIXELS) continue;
        large.add(key.asString().replace(/^\//, ""));
        if (filterNames(obj.dict).includes("/DCTDecode")) {
          const bytes = Buffer.from(obj.contents);
          const id = ref instanceof PDFRef ? ref.toString() : `${p}:${key.asString()}`;
          if (!seenImages.has(id)) {
            seenImages.add(id);
            const q = jpegInfo(bytes)?.quality;
            if (q != null) jpegQualities.push(q);
            if (images.length < 12) images.push({ width: w, height: h, jpeg: bytes });
          }
        }
      }
      const ops = scanContentOps(decodeContent(doc, node.get(PDFName.of("Contents"))), large);
      if (ops.largeImageDraws > 0) {
        scannedPages++;
        // A few visible words on a scan, or visible text next to an invisible OCR layer, is how scans get "corrected".
        if (ops.visibleText > 0 && (ops.visibleText <= 25 || ops.invisibleText > 0)) pagesWithTextOverImage.push(p + 1);
      }
    } catch {
      /* one malformed page does not stop the others */
    }
  }
  const fonts = [...prefixesByFont.keys()].sort();
  const duplicateSubsetFonts = fonts.filter((f) => (prefixesByFont.get(f)?.size ?? 0) >= 2);
  return { parsed: true, pages: pages.length, fonts, duplicateSubsetFonts, pagesWithTextOverImage, scannedPages, jpegQualities, images };
}
