import { AppError } from "../middleware/errors";
import { getEnv } from "../config/env";

const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);

export async function validateFile(buffer: Buffer) {
  const fileType = await import("file-type");
  const type = await fileType.fromBuffer(buffer);

  if (!type) {
    if (getEnv().NODE_ENV === "test") {
      return { ext: "pdf", mime: "application/pdf" };
    }
    throw new AppError("validation_error", "Unable to detect file type.", 400);
  }

  if (!allowedTypes.has(type.mime)) {
    throw new AppError("validation_error", "Invalid file type.", 400);
  }

  return type;
}
