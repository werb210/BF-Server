// BF_SERVER_v846_FRAUD - per-document work: read the file once, store its fingerprints (SHA-256 and perceptual hashes
// of its pictures) and the check 1 tamper result. Only hashes and a few numbers about the image are stored.
import { createHash } from "node:crypto";
import type { Q } from "./types.js";
import { classifyDocKind, extractPdfMeta } from "../services/documents/fraudSignals.js";
import { analyzePdfStructure, type PdfStructure } from "./pdfStructure.js";
import { dHash, decodeImage, informativeHash, isJpeg, isPng, isScreenSize, jpegInfo, pngInfo } from "./imageHash.js";
import { classifyKindPlus, evaluateDocumentTamper, IMAGE_EDITORS, type DocKindPlus } from "./checks/documentTamper.js";
import { upsertResult } from "./store.js";

export type DocRow = { id: string; application_id: string; category: string | null; storage_key: string | null; blob_name: string | null; storage_path: string | null };

export type LoadFile = (doc: DocRow) => Promise<Buffer | null>;

export type ImageInfo = {
  file_type: "pdf" | "jpeg" | "png" | "other";
  width: number | null;
  height: number | null;
  camera: boolean;
  editor: string | null;
  screen_sized: boolean;
};

export function idKindFor(kind: DocKindPlus): "id" | "void_cheque" | "bank_statement" | "other" {
  return kind === "id" || kind === "void_cheque" || kind === "bank_statement" ? kind : "other";
}

/** Load a stored file the way the tamper scan does: the active version's storage key, else the document's own. */
export async function defaultLoadFile(doc: DocRow): Promise<Buffer | null> {
  const { findActiveDocumentVersion } = await import("../modules/applications/applications.repo.js");
  const { getStorage } = await import("../lib/storage/index.js");
  const version = await findActiveDocumentVersion({ documentId: doc.id });
  const vmeta = version && version.metadata && typeof version.metadata === "object" ? (version.metadata as { storageKey?: string }) : {};
  const key = vmeta.storageKey ?? doc.storage_key ?? doc.blob_name ?? doc.storage_path;
  if (!key) return null;
  const file = await getStorage().get(key);
  return file?.buffer ? Buffer.from(file.buffer) : null;
}

export type DocumentScan = { documentId: string; kind: DocKindPlus; sha256: string; phashes: string[]; info: ImageInfo; status: string };

/** Fingerprint + tamper-scan one file and store both. Returns null when the file is gone. */
export async function scanDocument(db: Q, doc: DocRow, loadFile: LoadFile = defaultLoadFile): Promise<DocumentScan | null> {
  const kind = classifyKindPlus(doc.category, classifyDocKind);
  const buffer = await loadFile(doc);
  if (!buffer) {
    await db.query(
      `INSERT INTO document_fingerprints (document_id, application_id, sha256, phashes, id_kind, image_info)
       VALUES ($1, $2, NULL, '{}', $3, '{"file_type":"missing"}'::jsonb) ON CONFLICT (document_id) DO NOTHING`,
      [doc.id, doc.application_id, idKindFor(kind)],
    );
    await upsertResult(db, doc.application_id, "fraud_1", doc.id, { status: "not_applicable", reasons: [{ code: "file_missing", severity: "info", text: "The stored file could not be read, so it was not scanned." }] });
    return null;
  }
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const isPdf = buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-");
  const fileType: ImageInfo["file_type"] = isPdf ? "pdf" : isJpeg(buffer) ? "jpeg" : isPng(buffer) ? "png" : "other";
  const phashes: string[] = [];
  let structure: PdfStructure | null = null;
  const jinfo = fileType === "jpeg" ? jpegInfo(buffer) : null;
  const pinfo = fileType === "png" ? pngInfo(buffer) : null;
  if (isPdf) {
    structure = await analyzePdfStructure(buffer);
    for (const img of structure.images) {
      const decoded = decodeImage(img.jpeg);
      if (decoded) { const h = dHash(decoded); if (informativeHash(h)) phashes.push(h); }
    }
  } else if (fileType === "jpeg" || fileType === "png") {
    const decoded = decodeImage(buffer);
    if (decoded) { const h = dHash(decoded); if (informativeHash(h)) phashes.push(h); }
  }
  const width = jinfo?.width ?? pinfo?.width ?? null;
  const height = jinfo?.height ?? pinfo?.height ?? null;
  const software = (jinfo?.software ?? pinfo?.software ?? "").toLowerCase();
  const info: ImageInfo = {
    file_type: fileType, width, height,
    camera: Boolean(jinfo?.make || jinfo?.model),
    editor: IMAGE_EDITORS.find((e) => software.includes(e)) ?? null,
    screen_sized: width != null && height != null && isScreenSize(width, height),
  };
  const meta = isPdf ? await extractPdfMeta(buffer) : null;
  const tamper = evaluateDocumentTamper({ kind, fileType, meta, structure, jpeg: jinfo, pngSoftware: pinfo?.software ?? null });
  await db.query(
    `INSERT INTO document_fingerprints (document_id, application_id, sha256, phashes, id_kind, image_info)
     VALUES ($1, $2, $3, $4::text[], $5, $6::jsonb)
     ON CONFLICT (document_id) DO UPDATE SET sha256 = EXCLUDED.sha256, phashes = EXCLUDED.phashes,
       id_kind = EXCLUDED.id_kind, image_info = EXCLUDED.image_info`,
    [doc.id, doc.application_id, sha256, phashes, idKindFor(kind), JSON.stringify(info)],
  );
  await upsertResult(db, doc.application_id, "fraud_1", doc.id, tamper);
  return { documentId: doc.id, kind, sha256, phashes, info, status: tamper.status };
}
