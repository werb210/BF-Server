// BF_SERVER_BLOCK_DOC_VERSION_FIX_v80 — uploads must create a document_versions
// row alongside the documents row. Before this fix, OCR enqueued for every
// upload then failed forever with "document_version_missing", spamming Azure
// logs and leaving every uploaded doc unreadable by the credit-summary engine,
// banking analyzer, and lender package builder.
import express, { type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../middleware/response.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import { pool } from "../db.js";
import { getStorage } from "../lib/storage/index.js";
import { enqueueOcrForDocument } from "../modules/ocr/ocr.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function persistAndEnqueue(opts: {
  applicationId: string;
  category: string;
  file: Express.Multer.File;
  uploadedBy?: string | null;
}) {
  const store = getStorage();
  const put = await store.put({
    buffer: opts.file.buffer,
    filename: opts.file.originalname,
    contentType: opts.file.mimetype,
    pathPrefix: `applications/${opts.applicationId}`,
  });

  const documentId = randomUUID();
  const versionId = randomUUID();
  const versionMetadata = {
    mimeType: opts.file.mimetype,
    fileName: opts.file.originalname,
    sizeBytes: put.sizeBytes,
    uploadedAt: new Date().toISOString(),
  };

  // Single transaction so a failed version insert rolls back the document.
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");

    // documents row. The two-step fallback preserves compatibility with older
    // schemas that may not have all the new columns yet.
    try {
      await tx.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category, document_type,
            storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,'uploaded','pending',$10,now(),now())`,
        [
          documentId,
          opts.applicationId,
          opts.file.originalname,
          put.hash,
          opts.category,
          put.blobName,
          put.blobName,
          put.url,
          put.sizeBytes,
          opts.uploadedBy ?? null,
        ]
      );
    } catch {
      // Schema fallback: minimal columns only.
      await tx.query(
        `INSERT INTO documents (id, application_id, filename, hash, document_type, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'uploaded',now(),now())`,
        [documentId, opts.applicationId, opts.file.originalname, put.hash, opts.category]
      );
    }

    // document_versions row — what OCR + credit summary + banking analyzer
    // actually read from. Without this, every downstream worker fails.
    await tx.query(
      `INSERT INTO document_versions
         (id, document_id, version, blob_name, hash, metadata, content, created_at)
       VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
      [
        versionId,
        documentId,
        put.blobName,
        put.hash,
        JSON.stringify(versionMetadata),
        put.url,
      ]
    );

    await tx.query("COMMIT");
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    tx.release();
  }

  // OCR is best-effort — if it fails we still return success for the upload.
  try {
    await enqueueOcrForDocument(documentId);
  } catch (err) {
    console.warn("[documents] OCR enqueue failed", { documentId, err: String(err) });
  }

  return {
    id: documentId,
    versionId,
    hash: put.hash,
    sizeBytes: put.sizeBytes,
    blobName: put.blobName,
  };
}

router.post("/public-upload", upload.single("file"), async (req: Request, res: Response) => {
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : "";
  if (!applicationId || !category) return fail(res, 400, "MISSING_FIELDS");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "NO_FILE");
  try {
    const r = await persistAndEnqueue({ applicationId, category, file, uploadedBy: null });
    return ok(res, {
      id: r.id,
      versionId: r.versionId,
      applicationId,
      filename: file.originalname,
      hash: r.hash,
      size: r.sizeBytes,
      status: "uploaded",
    });
  } catch (err) {
    console.error("[documents] public-upload failed", { applicationId, category, err: String(err) });
    return fail(res, 500, "UPLOAD_FAILED");
  }
});

router.post("/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : null;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!applicationId || !category || !file) return fail(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");
  try {
    const userId = (req as any)?.user?.id ?? null;
    const r = await persistAndEnqueue({ applicationId, category, file, uploadedBy: userId });
    return ok(res, {
      id: r.id,
      versionId: r.versionId,
      applicationId,
      filename: file.originalname,
      hash: r.hash,
      size: r.sizeBytes,
      status: "uploaded",
    });
  } catch (err) {
    console.error("[documents] upload failed", { applicationId, category, err: String(err) });
    return fail(res, 500, "UPLOAD_FAILED");
  }
});

router.post("/:id/accept", requireAuth, async (req: Request, res: Response) => {
  const id = toStringSafe(req.params.id);
  await pool.query(`UPDATE documents SET status='accepted', updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  return ok(res, { id, status: "accepted" });
});

router.post("/:id/reject", requireAuth, async (req: Request, res: Response) => {
  const id = toStringSafe(req.params.id);
  await pool.query(`UPDATE documents SET status='rejected', updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  return ok(res, { id, status: "rejected" });
});

export default router;
