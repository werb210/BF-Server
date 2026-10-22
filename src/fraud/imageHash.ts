// BF_SERVER_v846_FRAUD - perceptual hashes and image metadata for uploaded files.
//
// dHash (difference hash): shrink the picture to 9x8 grey pixels and record whether each pixel is brighter than the
// one to its right. Re-saving, resizing or re-compressing a picture barely changes the 64 bits, so two hashes a few
// bits apart are almost certainly the same picture (the same ID or void cheque uploaded again).
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export type DecodedImage = { width: number; height: number; data: Uint8Array | Buffer };

export function isJpeg(b: Buffer): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function isPng(b: Buffer): boolean {
  return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

/** RGBA pixels for a JPEG or PNG, or null (other formats, corrupt files, images too large to decode safely). */
export function decodeImage(b: Buffer): DecodedImage | null {
  try {
    if (isJpeg(b)) {
      const img = jpeg.decode(b, { useTArray: true, maxResolutionInMP: 60, maxMemoryUsageInMB: 512, tolerantDecoding: true });
      return { width: img.width, height: img.height, data: img.data };
    }
    if (isPng(b)) {
      const img = PNG.sync.read(b);
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    return null;
  }
  return null;
}

/** 64-bit difference hash as 16 hex characters. */
export function dHash(img: DecodedImage): string {
  const W = 9, H = 8;
  const grey: number[] = new Array(W * H).fill(0);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor((y * img.height) / H), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor((x * img.width) / W), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / W));
      // Sample at most 16x16 points per cell so a 12-megapixel photo stays fast.
      const sy = Math.max(1, Math.floor((y1 - y0) / 16)), sx = Math.max(1, Math.floor((x1 - x0) / 16));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy += sy) {
        for (let xx = x0; xx < x1; xx += sx) {
          const i = (yy * img.width + xx) * 4;
          sum += 0.299 * (img.data[i] ?? 0) + 0.587 * (img.data[i + 1] ?? 0) + 0.114 * (img.data[i + 2] ?? 0);
          n++;
        }
      }
      grey[y * W + x] = n ? sum / n : 0;
    }
  }
  let bits = "";
  for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) bits += grey[y * W + x]! > grey[y * W + x + 1]! ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** A hash with almost no detail (blank page, solid colour) matches everything; never compare those. */
export function informativeHash(h: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(h)) return false;
  const ones = hamming(h, "0000000000000000");
  return ones >= 6 && ones <= 58;
}

export const NEAR_DUPLICATE_BITS = 5;

export type JpegInfo = {
  software: string | null;
  make: string | null;
  model: string | null;
  photoshop: boolean;
  adobe: boolean;
  /** Estimated JPEG quality (1-100) from the luminance quantisation table, or null. */
  quality: number | null;
  width: number | null;
  height: number | null;
};

// IJG standard luminance table (quality 50), zig-zag order does not matter for a sum.
const STD_LUMA = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22,
  29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99];
const STD_SUM = STD_LUMA.reduce((a, b) => a + b, 0);

export function qualityFromTable(table: number[]): number | null {
  if (table.length < 64) return null;
  const sum = table.slice(0, 64).reduce((a, b) => a + b, 0);
  if (sum <= 64) return 100;
  const scale = (sum * 100) / STD_SUM; // IJG: scale = q < 50 ? 5000/q : 200 - 2q
  const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
  return Math.max(1, Math.min(100, Math.round(q)));
}

function readAscii(b: Buffer, start: number, len: number): string {
  return b.subarray(start, start + len).toString("latin1").replace(/\0+$/, "").trim();
}

/** EXIF IFD0 Software (0x0131), Make (0x010f), Model (0x0110) from an APP1 segment body. */
function parseExif(seg: Buffer): { software: string | null; make: string | null; model: string | null } {
  const out = { software: null as string | null, make: null as string | null, model: null as string | null };
  if (seg.subarray(0, 6).toString("latin1") !== "Exif\0\0") return out;
  const t = seg.subarray(6);
  const le = t.subarray(0, 2).toString("latin1") === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  try {
    const ifd = u32(4);
    const n = u16(ifd);
    for (let i = 0; i < n && i < 200; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type !== 2) continue;
      const off = count <= 4 ? e + 8 : u32(e + 8);
      const val = readAscii(t, off, Math.min(count, 200));
      if (tag === 0x0131) out.software = val || null;
      if (tag === 0x010f) out.make = val || null;
      if (tag === 0x0110) out.model = val || null;
    }
  } catch {
    /* malformed EXIF: treat as absent */
  }
  return out;
}

export function jpegInfo(b: Buffer): JpegInfo | null {
  if (!isJpeg(b)) return null;
  const info: JpegInfo = { software: null, make: null, model: null, photoshop: false, adobe: false, quality: null, width: null, height: null };
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan
    const len = b.readUInt16BE(i + 2);
    const body = b.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1) Object.assign(info, Object.fromEntries(Object.entries(parseExif(body)).filter(([, v]) => v)));
    if (marker === 0xed && body.subarray(0, 13).toString("latin1") === "Photoshop 3.0") info.photoshop = true;
    if (marker === 0xee && body.subarray(0, 5).toString("latin1") === "Adobe") info.adobe = true;
    if (marker === 0xdb && info.quality == null) {
      // first table: Pq/Tq byte then 64 values (8-bit when Pq = 0)
      const pq = (body[0] ?? 0) >> 4;
      const vals: number[] = [];
      for (let k = 0; k < 64; k++) vals.push(pq ? body.readUInt16BE(1 + k * 2) : body[1 + k] ?? 0);
      info.quality = qualityFromTable(vals);
    }
    if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && body.length >= 5) {
      info.height = body.readUInt16BE(1);
      info.width = body.readUInt16BE(3);
    }
    i += 2 + len;
  }
  return info;
}

/** PNG tEXt "Software" and the image size. */
export function pngInfo(b: Buffer): { software: string | null; width: number; height: number } | null {
  if (!isPng(b) || b.length < 24) return null;
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  let software: string | null = null;
  let i = 8;
  while (i + 8 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.subarray(i + 4, i + 8).toString("latin1");
    if (type === "tEXt" || type === "iTXt") {
      const data = b.subarray(i + 8, i + 8 + Math.min(len, 400)).toString("latin1");
      const [k, ...rest] = data.split("\0");
      if (k === "Software") software = rest.join(" ").replace(/\0/g, " ").trim() || null;
    }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return { software, width, height };
}

/** Phone, tablet and monitor screen sizes (either orientation). An ID "photo" at exactly one of these is a screenshot. */
export const SCREEN_SIZES: ReadonlyArray<[number, number]> = [
  [750, 1334], [828, 1792], [1125, 2436], [1170, 2532], [1179, 2556], [1242, 2688], [1242, 2208], [1284, 2778], [1290, 2796],
  [1206, 2622], [1320, 2868], [640, 1136], [1080, 1920], [1080, 2340], [1080, 2400], [1080, 2412], [1440, 3200], [1440, 3120],
  [1440, 2560], [720, 1600], [1536, 2048], [1620, 2160], [1668, 2388], [2048, 2732], [1366, 768], [1920, 1080], [2560, 1440],
  [1536, 864], [1440, 900], [1280, 800], [2880, 1800], [2560, 1600], [3024, 1964], [3456, 2234], [1280, 720], [3840, 2160],
];

export function isScreenSize(w: number, h: number): boolean {
  return SCREEN_SIZES.some(([a, b]) => (w === a && h === b) || (w === b && h === a));
}
