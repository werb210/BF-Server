// BF_SERVER_v848_OFFICE_DOCS
// The OCR model reads PDFs and images only. Word, Excel, CSV and plain-text files used to fail OCR three times with
// "unsupported_mime_type" and were never read. They are now turned into plain text here and sent to the model as
// text. A file type that still cannot be read (old .doc/.xls, anything else) fails once, permanently, instead of
// being retried.
import JSZip from "jszip";
import mammoth from "mammoth";

/** Characters of converted text sent to the model; the rest is cut with a note. */
export const MAX_OCR_TEXT_CHARS = 100_000;
/** A single zipped part bigger than this when unzipped is not opened (zip-bomb guard). */
const MAX_PART_BYTES = 40 * 1024 * 1024;

/** An OCR failure that will fail the same way every time: the job stops instead of retrying. */
export class OcrPermanentError extends Error {
  readonly permanent = true;
  constructor(message: string) {
    super(message);
    this.name = "OcrPermanentError";
  }
}

export function isPermanentOcrError(error: unknown): boolean {
  if (error instanceof OcrPermanentError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /^(unsupported_mime_type|document_has_no_text|document_unreadable)\b/.test(message);
}

export type TextDocumentKind = "docx" | "xlsx" | "csv" | "text";

const MIME_KINDS: Record<string, TextDocumentKind> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/tab-separated-values": "csv",
  "text/plain": "text",
};
const EXT_KINDS: Record<string, TextDocumentKind> = {
  docx: "docx", xlsx: "xlsx", xlsm: "xlsx", csv: "csv", tsv: "csv", txt: "text",
};

function extensionOf(fileName: string | undefined): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(fileName ?? "").trim());
  return m ? m[1].toLowerCase() : "";
}

const isZip = (buffer: Buffer): boolean => buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

/**
 * Which text conversion applies. The file name wins (Windows browsers label .csv files
 * "application/vnd.ms-excel"), then the MIME type, then - for a ZIP labelled with a generic type -
 * what is inside it.
 */
export async function textDocumentKind(buffer: Buffer, mimeType: string, fileName?: string): Promise<TextDocumentKind | null> {
  const byExt = EXT_KINDS[extensionOf(fileName)];
  if (byExt) return byExt;
  const mime = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (MIME_KINDS[mime]) return MIME_KINDS[mime];
  if ((mime === "" || mime === "application/octet-stream" || mime === "application/zip") && isZip(buffer)) {
    try {
      const zip = await JSZip.loadAsync(buffer);
      if (zip.file("word/document.xml")) return "docx";
      if (zip.file("xl/workbook.xml")) return "xlsx";
    } catch {
      return null;
    }
  }
  return null;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|lt|gt|amp|quot|apos);/gi, (whole, code: string) => {
    const c = code.toLowerCase();
    if (c === "lt") return "<";
    if (c === "gt") return ">";
    if (c === "amp") return "&";
    if (c === "quot") return '"';
    if (c === "apos") return "'";
    const n = c.startsWith("#x") ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

/** The visible text of a shared string or inline string (phonetic runs left out). */
function runText(xml: string): string {
  const visible = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of visible.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += decodeXml(m[1]);
  return out;
}

function columnIndex(ref: string | undefined): number | null {
  const m = /^([A-Z]+)\d*$/i.exec(String(ref ?? ""));
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
};

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  if (size > MAX_PART_BYTES) throw new OcrPermanentError("document_unreadable:part_too_large");
  return entry.async("string");
}

/** Every sheet as tab-separated rows, headed by the sheet name. Stops once `limit` characters are produced. */
export async function xlsxToText(buffer: Buffer, limit = MAX_OCR_TEXT_CHARS + 1): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const shared: string[] = [];
  const sst = await readPart(zip, "xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g)) shared.push(m[1] ? runText(m[1]) : "");

  // Sheet order and names from the workbook; paths from its relationships file.
  const sheets: Array<{ name: string; path: string }> = [];
  const workbook = (await readPart(zip, "xl/workbook.xml")) ?? "";
  const rels = (await readPart(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`);
  }
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const rid = attr(m[1], "r:id");
    const path = rid ? targets.get(rid) : undefined;
    if (path && zip.file(path)) sheets.push({ name: decodeXml(attr(m[1], "name") ?? path), path });
  }
  if (sheets.length === 0) {
    for (const path of Object.keys(zip.files).filter((p) => /^xl\/worksheets\/[^/]+\.xml$/.test(p)).sort()) {
      sheets.push({ name: path.replace(/^.*\/|\.xml$/g, ""), path });
    }
  }

  const lines: string[] = [];
  let length = 0;
  const push = (line: string): boolean => { lines.push(line); length += line.length + 1; return length < limit; };
  outer: for (const sheet of sheets) {
    const xml = (await readPart(zip, sheet.path)) ?? "";
    if (!push(`Sheet: ${sheet.name}`)) break;
    for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const cells: string[] = [];
      let next = 0;
      for (const c of String(row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? "";
        const col = columnIndex(attr(attrs, "r")) ?? next;
        next = col + 1;
        const type = attr(attrs, "t");
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = runText(body);
        else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
        else if (v !== undefined) value = decodeXml(v);
        value = value.replace(/[\t\r\n]+/g, " ").trim();
        if (value === "") continue;
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      if (cells.length > 0 && !push(cells.join("\t"))) break outer;
    }
    if (!push("")) break;
  }
  return lines.join("\n").trim();
}

export type ConvertedDocument = { kind: TextDocumentKind; text: string; truncated: boolean; originalChars: number };

/**
 * Plain text for a Word / Excel / CSV / text file, cut to MAX_OCR_TEXT_CHARS.
 * Throws OcrPermanentError for a type it cannot read, a file it cannot open, or one with no text.
 */
export async function documentToText(buffer: Buffer, mimeType: string, fileName?: string): Promise<ConvertedDocument> {
  const kind = await textDocumentKind(buffer, mimeType, fileName);
  if (!kind) throw new OcrPermanentError(`unsupported_mime_type:${String(mimeType || "unknown").slice(0, 100)}`);
  let text: string;
  try {
    if (kind === "docx") text = (await mammoth.extractRawText({ buffer })).value;
    else if (kind === "xlsx") text = await xlsxToText(buffer);
    else text = buffer.toString("utf8").replace(/^﻿/, "");
  } catch (err) {
    if (err instanceof OcrPermanentError) throw err;
    throw new OcrPermanentError(`document_unreadable:${kind}:${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
  }
  text = text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new OcrPermanentError(`document_has_no_text:${kind}`);
  const originalChars = text.length;
  const truncated = originalChars > MAX_OCR_TEXT_CHARS;
  if (truncated) text = `${text.slice(0, MAX_OCR_TEXT_CHARS)}\n[... ${originalChars - MAX_OCR_TEXT_CHARS} more characters not shown]`;
  return { kind, text, truncated, originalChars };
}
