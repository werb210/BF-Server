// BF_SERVER_v789 [SG7] - read what a generated PDF actually draws, so tests can assert on the rendered
// document (text, where it sits, the lines it draws) instead of on the builder's source code.
// Handles the content streams pdf-lib writes: Flate-compressed, text placed with "a b c d x y Tm",
// shown with "<hex> Tj" or "(literal) Tj", and strokes drawn as "x y m ... x2 y2 l S".
import zlib from "node:zlib";

export type PdfTextRun = { text: string; x: number; y: number; size: number };
export type PdfLine = { x1: number; y1: number; x2: number; y2: number };

function contentStreams(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  const out: string[] = [];
  const re = /(?<!end)stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    try {
      out.push(zlib.inflateSync(chunk).toString("latin1"));
    } catch {
      out.push(chunk.toString("latin1"));
    }
    re.lastIndex = end + "endstream".length;
  }
  return out;
}

function decodeLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\])/g, (_m, c: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[c] ?? c);
}

export function pdfContent(bytes: Uint8Array): { runs: PdfTextRun[]; lines: PdfLine[]; text: string } {
  const runs: PdfTextRun[] = [];
  const lines: PdfLine[] = [];
  for (const stream of contentStreams(bytes)) {
    let size = 0;
    let x = 0;
    let y = 0;
    const tokens = stream.split("\n");
    let moveTo: { x: number; y: number } | null = null;
    for (const t of tokens) {
      let mm: RegExpMatchArray | null;
      if ((mm = t.match(/\s([\d.]+)\s+Tf$/))) size = Number(mm[1]);
      else if ((mm = t.match(/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ ([-\d.]+) ([-\d.]+) Tm$/))) { x = Number(mm[1]); y = Number(mm[2]); }
      else if ((mm = t.match(/^<([0-9A-Fa-f]*)> Tj$/))) runs.push({ text: Buffer.from(mm[1], "hex").toString("latin1"), x, y, size });
      else if ((mm = t.match(/^\((.*)\) Tj$/))) runs.push({ text: decodeLiteral(mm[1]), x, y, size });
      else if ((mm = t.match(/^([-\d.]+) ([-\d.]+) m$/))) moveTo = { x: Number(mm[1]), y: Number(mm[2]) };
      else if ((mm = t.match(/^([-\d.]+) ([-\d.]+) l$/)) && moveTo) {
        lines.push({ x1: moveTo.x, y1: moveTo.y, x2: Number(mm[1]), y2: Number(mm[2]) });
        moveTo = { x: Number(mm[1]), y: Number(mm[2]) };
      }
    }
  }
  return { runs, lines, text: runs.map((r) => r.text).join("\n") };
}
