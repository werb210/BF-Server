import { AppError } from "../middleware/errors";

const allowedMagic = [
  { mime: "application/pdf", sig: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
  { mime: "image/png", sig: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { mime: "image/jpeg", sig: Buffer.from([0xff, 0xd8, 0xff]) },
] as const;

export async function validateFile(buffer: Buffer) {
  for (const entry of allowedMagic) {
    if (buffer.subarray(0, entry.sig.length).equals(entry.sig)) {
      return { ext: entry.mime.split("/")[1], mime: entry.mime };
    }
  }

  throw new AppError("validation_error", "Invalid file type.", 400);
}
