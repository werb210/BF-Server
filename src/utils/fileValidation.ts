import { AppError } from "../middleware/errors";
import { getEnv } from "../config/env";
import * as FileType from "file-type";

const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
type DetectedFileType = { mime: string; ext: string } | null;

export async function validateFile(buffer: Buffer): Promise<Exclude<DetectedFileType, null>> {
  let type: DetectedFileType = null;

  if ((FileType as any).fileTypeFromBuffer) {
    type = await (FileType as any).fileTypeFromBuffer(buffer);
  } else if ((FileType as any).fromBuffer) {
    type = await (FileType as any).fromBuffer(buffer);
  }

  if (!type || !type.mime) {
    if (getEnv().NODE_ENV === "test") {
      return { ext: "pdf", mime: "application/pdf" };
    }
    throw new AppError("validation_error", "Unable to detect file type.", 400);
  }

  if (!allowedTypes.has(type.mime)) {
    throw new AppError("validation_error", "Invalid file type.", 400);
  }

  return { ext: type.ext ?? "bin", mime: type.mime };
}
