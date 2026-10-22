// BF_SERVER_v846_FRAUD - test files built in memory: PDFs with text and page images, JPEGs with EXIF, PNGs.
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** A width x height picture with a diagonal gradient and a block, so its hash has detail. */
export function pixels(width: number, height: number, variant = 0): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const block = x > width * 0.3 && x < width * (0.6 + variant * 0.2) && y > height * 0.2 && y < height * 0.5;
      const fx = x / width, fy = y / height;
      const wave = Math.sin(fx * (9 + variant * 5) + variant) * Math.cos(fy * (7 + variant * 3)) * 0.5 + 0.5;
      const v = block ? 30 : Math.floor(wave * 255);
      data[i] = v; data[i + 1] = variant ? 255 - v : v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return data;
}

export function makeJpeg(width = 600, height = 400, quality = 85, variant = 0): Buffer {
  return Buffer.from(jpeg.encode({ data: pixels(width, height, variant), width, height }, quality).data);
}

export function makePng(width = 600, height = 400, software: string | null = null): Buffer {
  const png = new PNG({ width, height });
  pixels(width, height).copy(png.data);
  const buf = PNG.sync.write(png);
  if (!software) return buf;
  // insert a tEXt chunk (Software) right after IHDR (8 + 25 bytes)
  const text = Buffer.from(`Software\0${software}`, "latin1");
  const chunk = Buffer.alloc(12 + text.length);
  chunk.writeUInt32BE(text.length, 0);
  chunk.write("tEXt", 4, "latin1");
  text.copy(chunk, 8);
  chunk.writeUInt32BE(0, 8 + text.length); // CRC not verified by our reader
  return Buffer.concat([buf.subarray(0, 33), chunk, buf.subarray(33)]);
}

/** Add an EXIF APP1 segment with Software / Make tags to a JPEG. */
export function withExif(jpg: Buffer, tags: { software?: string; make?: string }): Buffer {
  const entries: Array<[number, string]> = [];
  if (tags.make) entries.push([0x010f, tags.make]);
  if (tags.software) entries.push([0x0131, tags.software]);
  const ifdSize = 2 + entries.length * 12 + 4;
  const strings = entries.map(([, v]) => Buffer.from(v + "\0", "latin1"));
  const tiff = Buffer.alloc(8 + ifdSize + strings.reduce((a, s) => a + s.length, 0));
  tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries.length, 8);
  let strOff = 8 + ifdSize;
  entries.forEach(([tag], k) => {
    const e = 10 + k * 12;
    tiff.writeUInt16LE(tag, e); tiff.writeUInt16LE(2, e + 2); tiff.writeUInt32LE(strings[k]!.length, e + 4); tiff.writeUInt32LE(strOff, e + 8);
    strings[k]!.copy(tiff, strOff); strOff += strings[k]!.length;
  });
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xe1; seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([jpg.subarray(0, 2), seg, body, jpg.subarray(2)]);
}

/** A text-only "statement" PDF. */
export async function textPdf(opts: { producer?: string; lines?: string[]; fonts?: number } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  if (opts.producer) doc.setProducer(opts.producer);
  const page = doc.addPage([612, 792]);
  const names = [StandardFonts.Helvetica, StandardFonts.Courier, StandardFonts.TimesRoman, StandardFonts.HelveticaBold, StandardFonts.CourierBold, StandardFonts.TimesRomanBold, StandardFonts.HelveticaOblique, StandardFonts.CourierOblique];
  const fonts = await Promise.all(names.slice(0, opts.fonts ?? 1).map((n) => doc.embedFont(n)));
  (opts.lines ?? ["Statement of account", "Opening balance 1,000.00"]).forEach((l, i) => page.drawText(l, { x: 50, y: 700 - i * 20, size: 11, font: fonts[i % fonts.length] }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A "scanned" PDF: each page is one large JPEG, optionally with a few typed words on top. */
export async function scannedPdf(opts: { pages?: Array<{ quality: number; overlay?: string }> } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const p of opts.pages ?? [{ quality: 80 }]) {
    const img = await doc.embedJpg(makeJpeg(800, 1000, p.quality));
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
    if (p.overlay) page.drawText(p.overlay, { x: 300, y: 400, size: 12, font });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
