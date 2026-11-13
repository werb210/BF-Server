// BF_SERVER_v867_BROKER_TOOLS_CONTRACTS - Word (.docx) templates: read the zip, fill {{merge.fields}}, write the zip back, and turn
// the filled document into a plain, readable PDF (headings, paragraphs, lists, tables) with a signature page that
// carries SignNow text tags. No external tools: node:zlib for the zip and pdf-lib for the PDF.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

// ------------------------------------------------------------------------------------------------ zip
export type ZipFile = { name: string; data: Buffer };
export class DocxError extends Error {}

export function unzip(buf: Buffer): ZipFile[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new DocxError("This is not a Word (.docx) file.");
  const count = buf.readUInt16LE(end + 10);
  let ptr = buf.readUInt32LE(end + 16);
  const out: ZipFile[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) throw new DocxError("The Word file is damaged.");
    const flags = buf.readUInt16LE(ptr + 8), method = buf.readUInt16LE(ptr + 10), csize = buf.readUInt32LE(ptr + 20), size = buf.readUInt32LE(ptr + 24);
    const nl = buf.readUInt16LE(ptr + 28), xl = buf.readUInt16LE(ptr + 30), cl = buf.readUInt16LE(ptr + 32), lo = buf.readUInt32LE(ptr + 42);
    const name = buf.subarray(ptr + 46, ptr + 46 + nl).toString(flags & 0x800 ? "utf8" : "latin1");
    ptr += 46 + nl + xl + cl;
    if (flags & 1) throw new DocxError("The Word file is password-protected.");
    total += size;
    if (total > 60 * 1024 * 1024) throw new DocxError("The Word file is too large.");
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new DocxError("The Word file is damaged.");
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csize);
    if (name.endsWith("/")) continue;
    out.push({ name, data: method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : (() => { throw new DocxError("The Word file uses an unsupported compression."); })() });
  }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; t[n] = v >>> 0; } return t; })();
function crc32(b: Buffer): number { let v = 0xffffffff; for (const x of b) v = CRC[(v ^ x) & 0xff]! ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0; }

export function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8"), body = deflateRawSync(f.data), crc = crc32(f.data);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(f.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ------------------------------------------------------------------------------------------------ merge fields
const XML_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const FIELD = /\{\{\s*([A-Za-z][A-Za-z0-9_.]*)\s*\}\}/g;
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const T_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;

function paragraphText(p: string): string {
  let s = "";
  for (const m of p.matchAll(T_RE)) s += decode(m[1]!);
  return s;
}

/** The merge fields a template uses, e.g. ["business.legal_name", "structure.payment"] (Word may split a field across
 *  runs; fields are found in each paragraph's joined text). */
export function templateFields(docx: Buffer): string[] {
  const found = new Set<string>();
  for (const f of unzip(docx)) {
    if (!XML_PARTS.test(f.name)) continue;
    for (const p of f.data.toString("utf8").match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) for (const m of paragraphText(p).matchAll(FIELD)) found.add(m[1]!);
  }
  return [...found].sort();
}

/** Fills every {{field}} with its value. A paragraph that holds a field is rewritten into its first text run (its other
 *  runs emptied), so a field Word split across runs still merges. Unknown fields are left blank and reported. */
export function mergeDocx(docx: Buffer, values: Record<string, string>): { docx: Buffer; missing: string[] } {
  const missing = new Set<string>();
  const files = unzip(docx).map((f) => {
    if (!XML_PARTS.test(f.name)) return f;
    const xml = f.data.toString("utf8").replace(/<w:p\b[\s\S]*?<\/w:p>/g, (p) => {
      const text = paragraphText(p);
      if (!FIELD.test(text)) return p;
      FIELD.lastIndex = 0;
      const merged = text.replace(FIELD, (_m, key: string) => {
        const v = values[key];
        if (v === undefined || v === null || v === "") { missing.add(key); return ""; }
        return v;
      });
      let first = true;
      return p.replace(T_RE, () => {
        if (!first) return "<w:t></w:t>";
        first = false;
        return `<w:t xml:space="preserve">${encode(merged)}</w:t>`;
      });
    });
    return { name: f.name, data: Buffer.from(xml, "utf8") };
  });
  if (!files.some((f) => f.name === "word/document.xml")) throw new DocxError("This Word file has no document body.");
  return { docx: zip(files), missing: [...missing].sort() };
}

// ------------------------------------------------------------------------------------------------ text for the PDF
export type Block = { kind: "heading" | "para" | "bullet" | "row" | "pagebreak"; text: string };

function runsText(p: string): string {
  let s = "";
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>/g)) {
    if (m[0].startsWith("<w:tab")) s += "    ";
    else if (m[0].startsWith("<w:br")) s += /w:type="page"/.test(m[0]) ? "\f" : "\n";
    else s += decode(m[1]!);
  }
  return s;
}

/** The document body as blocks, in order: headings, paragraphs, list items and table rows. */
export function docxBlocks(docx: Buffer): Block[] {
  const doc = unzip(docx).find((f) => f.name === "word/document.xml");
  if (!doc) throw new DocxError("This Word file has no document body.");
  const body = doc.data.toString("utf8");
  const out: Block[] = [];
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g)) {
    const chunk = m[0];
    if (chunk.startsWith("<w:tbl")) {
      for (const tr of chunk.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((tc) => (tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []).map(runsText).join(" ").trim());
        if (cells.some(Boolean)) out.push({ kind: "row", text: cells.join("   |   ") });
      }
      continue;
    }
    const text = runsText(chunk);
    const style = /<w:pStyle w:val="([^"]+)"/.exec(chunk)?.[1] ?? "";
    for (const [i, part] of text.split("\f").entries()) {
      if (i > 0) out.push({ kind: "pagebreak", text: "" });
      if (!part.trim() && i > 0) continue;
      out.push({ kind: /^(Heading|Title)/i.test(style) ? "heading" : /<w:numPr>/.test(chunk) || /List/i.test(style) ? "bullet" : "para", text: part });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ PDF
/** Text the standard PDF fonts can draw (WinAnsi): smart quotes and dashes simplified, other characters dropped. */
export function pdfSafe(s: string): string {
  return String(s ?? "").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .replace(/\u2022/g, "-").replace(/\u00A0/g, " ").replace(/[^\x09\x0A\x0D\x20-\x7E\u00A1-\u00FF]/g, "");
}

export type Signer = { name: string; email: string; role: string };

const PW = 612, PH = 792, M = 54;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(/(\s+)/);
    let line = "";
    for (const w of words) {
      const next = line + w;
      if (font.widthOfTextAtSize(next, size) <= width || !line.trim()) { line = next; continue; }
      lines.push(line.trimEnd());
      line = w.trimStart();
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut)); line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Marks a PDF that already carries its SignNow signature tags, so nothing stamps a second box on it. */
export const SIGN_TAGS_KEYWORD = "signnow-tags";
export async function hasSigningTags(pdf: Uint8Array): Promise<boolean> {
  try { return String((await PDFDocument.load(pdf)).getKeywords() ?? "").includes(SIGN_TAGS_KEYWORD); } catch { return false; }
}

/** TERM_SHEET_SIGN_BLOCK - a line of the document that is a place to sign, e.g. "Signature: ________   Date: ______".
 *  `date` says whether the same line also has a place for the date. */
export function signatureLine(text: string): { date: boolean } | null {
  if (!/\b(signature|signed(\s+by)?|sign\s+here)\b[^_]{0,24}_{4,}/i.test(text)) return null;
  return { date: /\bdated?\b[^_]{0,12}_{4,}/i.test(text) };
}
/** A line that is only a place for the date, e.g. "Date: ________". */
export function dateLine(text: string): boolean {
  return /^\s*dated?\b[^_]{0,12}_{4,}\s*$/i.test(text);
}

/** A readable PDF of the filled document with one SignNow signature and date tag per signer (tags are drawn in white
 *  so only SignNow sees them). By default the signatures go on a page of their own at the end. With
 *  `inlineSignatures` (term sheets) the first signer signs on the document's own signature line when it has one;
 *  otherwise the signature block follows the text, on the same page when there is room. */
export async function renderContractPdf(blocks: Block[], opts: { title: string; signers: Signer[]; footer: string; inlineSignatures?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const F = await doc.embedFont(StandardFonts.Helvetica), B = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle(pdfSafe(opts.title));
  if (opts.signers.length) doc.setKeywords([SIGN_TAGS_KEYWORD]);
  let page: PDFPage = doc.addPage([PW, PH]);
  let y = PH - M;
  const newPage = () => { page = doc.addPage([PW, PH]); y = PH - M; };
  const draw = (text: string, font: PDFFont, size: number, indent = 0, gapAfter = 4) => {
    for (const line of wrap(pdfSafe(text), font, size, PW - M * 2 - indent)) {
      if (y - size < M + 20) newPage();
      page.drawText(line, { x: M + indent, y: y - size, size, font, color: rgb(0.08, 0.1, 0.14) });
      y -= size * 1.35;
    }
    y -= gapAfter;
  };
  const ink = rgb(0.3, 0.3, 0.3), white = rgb(1, 1, 1);
  /** One signer's place to sign: a signature line and a date line, labelled, with the tags SignNow reads. */
  const signBlock = (s: Signer, withDate = true) => {
    if (y < M + 90) newPage();
    y -= 34;
    page.drawText(`{{t:s;r:y;o:"${s.role}";w:200;h:30;}}`, { x: M + 2, y: y + 6, size: 6, font: F, color: white });
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + 240, y: y + 2 }, thickness: 0.7, color: ink });
    if (withDate) {
      page.drawText(`{{t:t;r:y;o:"${s.role}";l:"Date";w:110;h:16;}}`, { x: M + 300, y: y + 6, size: 6, font: F, color: white });
      page.drawLine({ start: { x: M + 300, y: y + 2 }, end: { x: M + 420, y: y + 2 }, thickness: 0.7, color: ink });
      page.drawText("Date", { x: M + 300, y: y - 9, size: 8, font: F, color: ink });
    }
    page.drawText("Signature", { x: M, y: y - 9, size: 8, font: F, color: ink });
    y -= 24;
  };
  /** A place for the date on a line of its own. */
  const dateBlock = (s: Signer) => {
    if (y < M + 70) newPage();
    y -= 26;
    page.drawText(`{{t:t;r:y;o:"${s.role}";l:"Date";w:110;h:16;}}`, { x: M + 2, y: y + 6, size: 6, font: F, color: white });
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: M + 120, y: y + 2 }, thickness: 0.7, color: ink });
    page.drawText("Date", { x: M, y: y - 9, size: 8, font: F, color: ink });
    y -= 24;
  };
  const inline = Boolean(opts.inlineSignatures) && opts.signers.length > 0;
  let signedInline = false, datedInline = false;
  for (const b of blocks) {
    if (b.kind === "pagebreak") { newPage(); continue; }
    if (!b.text.trim()) { y -= 8; continue; }
    if (inline && b.kind !== "heading") {
      const sig = signedInline ? null : signatureLine(b.text);
      if (sig) { signBlock(opts.signers[0]!, true); signedInline = true; datedInline = true; continue; }
      if (signedInline && dateLine(b.text)) { if (!datedInline) { dateBlock(opts.signers[0]!); datedInline = true; } continue; }
    }
    if (b.kind === "heading") { y -= 4; draw(b.text, B, 13, 0, 6); }
    else if (b.kind === "bullet") draw(`-  ${b.text}`, F, 10.5, 10);
    else if (b.kind === "row") draw(b.text, F, 10, 0, 2);
    else draw(b.text, F, 10.5);
  }
  const left = inline && signedInline ? opts.signers.slice(1) : opts.signers;
  if (left.length) {
    if (inline) { if (y < M + 150) newPage(); else y -= 10; } else newPage();
    draw(inline && left.length === 1 ? "Signature" : "Signatures", B, inline ? 13 : 14, 0, inline ? 2 : 12);
    for (const s of left) {
      if (y < M + 120) newPage();
      draw(s.email ? `${s.name} (${s.email})` : s.name, B, 11, 0, 0);
      signBlock(s);
    }
  }
  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(pdfSafe(`${opts.footer} - page ${i + 1} of ${pages.length}`), { x: M, y: 28, size: 8, font: F, color: rgb(0.4, 0.42, 0.46) }));
  return doc.save();
}

/** A minimal .docx from paragraphs ("# " starts a heading) - used to make a starter template and in tests. */
export function simpleDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => p.startsWith("# ")
    ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${encode(p.slice(2))}</w:t></w:r></w:p>`
    : `<w:p><w:r><w:t xml:space="preserve">${encode(p)}</w:t></w:r></w:p>`).join("");
  const s = (t: string) => Buffer.from(t, "utf8");
  return zip([
    { name: "[Content_Types].xml", data: s('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>') },
    { name: "_rels/.rels", data: s('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: "word/document.xml", data: s(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`) },
  ]);
}
