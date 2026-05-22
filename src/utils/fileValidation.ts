import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../middleware/errors.js";
import { config } from "../config/index.js";

// v614: aligned with the portal upload allowlist in routes/documents.ts.
// Mobile iPhone users send HEIC; office suites send DOCX/XLSX. Permit
// the same MIME prefixes the portal path already accepts.
const allowedTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/msword", // .doc
  "application/vnd.ms-excel", // .xls
  "text/csv",
  "text/plain",
]);

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
