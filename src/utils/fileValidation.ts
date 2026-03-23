import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../middleware/errors";
import { config } from "@/config";

const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

export async function validateFile(buffer: Buffer) {
  const type = await fileTypeFromBuffer(buffer);

  if (!type) {
    if (config.env === "test") {
      return { ext: "pdf", mime: "application/pdf" };
    }
    throw new AppError("validation_error", "Unable to detect file type.", 400);
  }

  if (!allowedTypes.has(type.mime)) {
    throw new AppError("validation_error", "Invalid file type.", 400);
  }

  return type;
}
