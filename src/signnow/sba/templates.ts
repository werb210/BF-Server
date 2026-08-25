// BF_SERVER_SBA_FORM_FILL_v89
// Template loading. The official fillable PDFs live in blob storage rather than
// the repo: they are third-party government documents that SBA revises on its own
// schedule, and a revision should be a file swap, not a deploy.
import { logError } from "../../observability/logger.js";

export type SbaFormKey = "form_1919" | "form_912" | "form_413";

const BLOB_NAMES: Record<SbaFormKey, string> = {
  form_1919: process.env.SBA_1919_BLOB || "sba-form-1919-02-2025.pdf",
  form_912: process.env.SBA_912_BLOB || "sba-form-912-12-2028.pdf",
  form_413: process.env.SBA_413_BLOB || "sba-form-413-05-2024.pdf",
};

// Editions we have mapped field names against. If SBA publishes a newer one the
// names may move, so this is recorded next to the file rather than in a comment
// somewhere else.
export const TEMPLATE_EDITIONS: Record<SbaFormKey, string> = {
  form_1919: "02/2025, expires 06/30/2027",
  form_912: "12/2028",
  form_413: "05/2024, expires 08/31/2027",
};

export async function loadSbaTemplate(key: SbaFormKey): Promise<Uint8Array | null> {
  try {
    // BF_SERVER_SBA_TEMPLATE_IMPORT_FIX_v94
    // v89 guessed at services/blobStorage.downloadBlob. The real helper is
    // downloadBlobAsset in signnow/blobStorage.ts - the same one the Accord
    // blank form is loaded through, reading from borealstorageprod under the
    // container that already holds accord_revolving_credit_blank.pdf.
    const { downloadBlobAsset } = await import("../blobStorage.js");
    const buf = await downloadBlobAsset(BLOB_NAMES[key]);
    return buf ? new Uint8Array(buf) : null;
  } catch (err) {
    logError("sba_template_load_failed");
    console.warn("[sba_template]", key, BLOB_NAMES[key], err instanceof Error ? err.message : String(err));
    return null;
  }
}
