// BF_SERVER_v906_OCR_MIME - a document version saved without a mimeType (some background and email uploads) failed
// OCR on every attempt with "missing_document_mime_type" and was never read. The type is worked out from the file name
// and, failing that, from the file's first bytes. Migration 2026_11_21_v906_application_file.sql fills it in for the
// versions already saved and re-queues their OCR.

export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  csv: "text/csv",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  numbers: "application/vnd.apple.numbers",
};

/** The type a file name's extension stands for, or null. */
export function mimeFromFileName(name: unknown): string | null {
  const m = /\.([A-Za-z0-9]{2,7})\s*$/.exec(String(name ?? ""));
  if (!m) return null;
  return MIME_BY_EXTENSION[m[1]!.toLowerCase()] ?? null;
}

/** The type the file's first bytes show (PDF, PNG, JPEG, GIF, WEBP, TIFF, HEIC, ZIP-based Office files), or null. */
export function sniffMimeType(buffer: Buffer | Uint8Array | null | undefined): string | null {
  if (!buffer || buffer.length < 4) return null;
  const b = Buffer.from(buffer.subarray(0, 64));
  const ascii = b.toString("latin1");
  if (ascii.startsWith("%PDF") || ascii.slice(0, 1024).includes("%PDF-")) return "application/pdf";
  if (b[0] === 0x89 && ascii.slice(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii.startsWith("GIF8")) return "image/gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "image/webp";
  if (ascii.startsWith("II*\u0000") || ascii.startsWith("MM\u0000*")) return "image/tiff";
  if (ascii.slice(4, 8) === "ftyp" && /heic|heix|mif1|msf1|heif/.test(ascii.slice(8, 12))) return "image/heic";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    // A zip: Word and Excel files are zips; the name of the first entry tells them apart when present.
    if (ascii.includes("word/")) return MIME_BY_EXTENSION.docx!;
    if (ascii.includes("xl/")) return MIME_BY_EXTENSION.xlsx!;
    return null;
  }
  return null;
}

/** The stored type when there is one, else from the file name(s), else from the bytes. */
export function resolveMimeType(input: { stored?: unknown; fileNames?: unknown[]; buffer?: Buffer | null }): { mimeType: string | null; inferred: boolean } {
  const stored = typeof input.stored === "string" ? input.stored.trim() : "";
  if (stored) return { mimeType: stored, inferred: false };
  for (const n of input.fileNames ?? []) {
    const m = mimeFromFileName(n);
    if (m) return { mimeType: m, inferred: true };
  }
  const sniffed = sniffMimeType(input.buffer ?? null);
  return { mimeType: sniffed, inferred: Boolean(sniffed) };
}
