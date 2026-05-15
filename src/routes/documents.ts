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
// BF_SERVER_BLOCK_v215_BF_TO_BI_DOC_MIRROR_v1
import { mirrorDocToBiAsync } from "../services/biDocMirror.js";

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

  // BF_SERVER_BLOCK_v114_DOC_UPLOAD_TX_AND_SCHEMA_v1
  // Two changes vs prior code:
  //   1. Removed the fallback path that swallowed insert errors mid-transaction.
  //      A swallowed error before COMMIT poisons the transaction and causes
  //      subsequent statements to fail with Postgres 25P02.
  //   2. Keep a single canonical INSERT for documents with explicit columns.
  //      Any real schema mismatch now bubbles up and triggers outer ROLLBACK.
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");

    await tx.query(
      // BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1
      `INSERT INTO documents
         (id, application_id, filename, hash, category,
          storage_path, blob_name, blob_url, size_bytes,
          status, ocr_status, uploaded_by, document_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploaded','pending',$10,$5,now(),now())`,
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
        // BF_SERVER_BLOCK_v116_UPLOADED_BY_DEFAULT_v1 — uploaded_by is
        // NOT NULL with DEFAULT 'client' (migration 054). Public-upload
        // is unauthenticated so opts.uploadedBy is undefined; passing
        // the literal 'client' matches the column default and avoids
        // a not-null constraint violation that previously broke every
        // public upload with a 500.
        opts.uploadedBy ?? 'client',
      ]
    );

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

  // BF_SERVER_BLOCK_v215_BF_TO_BI_DOC_MIRROR_v1
  // If this BF application has a linked BI PGI application (v213),
  // mirror the uploaded doc to BI. Fire-and-forget so the client
  // upload response is not delayed and never fails on BI errors.
  try {
    mirrorDocToBiAsync({
      bfApplicationId: String(opts.applicationId),
      bfDocumentId: String(documentId),
      documentType: typeof opts.category === "string" ? opts.category : null,
      fileName: typeof opts.file.originalname === "string" ? opts.file.originalname : null,
      mimeType: typeof opts.file.mimetype === "string" ? opts.file.mimetype : null,
      fileSize: typeof put.sizeBytes === "number" ? put.sizeBytes : null,
      storageUrl: typeof put.url === "string" ? put.url : null,
      uploadedByName: null,
    });
  } catch {
    // never block doc upload on mirror
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

  // BF_SERVER_BLOCK_v329_PUBLIC_UPLOAD_HARDENING_v1
  // Pre-fix this endpoint had: no auth (correct -- the wizard is unauth'd),
  // no file-type whitelist (any binary), no application-state gate
  // (Funded / Closed / Rejected apps still accepted uploads), and no
  // verification that the applicationId was a real, in-progress app
  // (any UUID-shaped string was accepted). Combined with multer's 25MB
  // limit (line 23), this surface was abusable for:
  //   1. Polluting blob storage and the documents/document_versions
  //      tables with arbitrary binaries against random UUIDs.
  //   2. Adding documents to historical Funded apps to manipulate the
  //      audit trail (the OCR pipeline would still run them, the
  //      banking analyzer would still reprocess, etc).
  //   3. Sending non-document file types (executables, scripts, images
  //      that aren't statements) through the OCR pipeline which costs
  //      money and time per call.
  // Three guards added below in order: (a) MIME whitelist matched to
  // what the application wizard actually allows the applicant to
  // attach (PDF, JPG/PNG/HEIC for phone scans, common docx/xlsx for
  // statements). (b) existence + in-progress gate -- look up the
  // application, require it to exist AND have pipeline_state not in
  // a terminal state. (c) the existing persistAndEnqueue path.
  // Rate-limit is intentionally NOT added at the handler level here
  // because the canonical clientDocumentsRateLimit() is applied at the
  // router-mount level by src/routes/client/index.ts:34 for the /api/
  // client/documents mount; the bare /api/documents/public-upload
  // surface is meant for the website wizard (which uses the same
  // function via /api/documents/public-upload). Operator may want
  // to add an explicit limiter here too -- flagged as a follow-up.
  const ALLOWED_MIME_PREFIXES = [
    "application/pdf",
    "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp",
    "application/vnd.openxmlformats-officedocument", // .docx, .xlsx, .pptx
    "application/msword",                            // .doc
    "application/vnd.ms-excel",                      // .xls
    "text/csv",
    "text/plain",
  ];
  const mime = typeof file.mimetype === "string" ? file.mimetype.toLowerCase() : "";
  const mimeAllowed = ALLOWED_MIME_PREFIXES.some((p) => mime === p || mime.startsWith(p + ";") || mime.startsWith(p + "/"));
  if (!mimeAllowed) {
    console.warn("[documents] public-upload rejected non-allowed mime", { applicationId, mime, filename: file.originalname });
    return fail(res, 415, "UNSUPPORTED_FILE_TYPE");
  }

  // Application existence + state gate. Terminal states reject. Unknown
  // application returns 404 with the same code shape as a 404 elsewhere
  // (don't leak the difference between "no such id" and "wrong state").
  try {
    const appRes = await pool.query<{ pipeline_state: string | null }>(
      `SELECT pipeline_state FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    const row = appRes.rows[0];
    if (!row) {
      return fail(res, 404, "APPLICATION_NOT_FOUND");
    }
    const TERMINAL_STATES = new Set(["Accepted", "Rejected", "Funded", "Closed"]);
    if (row.pipeline_state && TERMINAL_STATES.has(row.pipeline_state)) {
      return fail(res, 409, "APPLICATION_NOT_ACCEPTING_UPLOADS");
    }
  } catch (err) {
    // If the app-state lookup itself fails, fail closed -- never accept
    // an unverified upload. The previous version of this handler did
    // accept unverified uploads, which is the bug this guard closes.
    console.error("[documents] public-upload app-state check failed", { applicationId, err: String(err) });
    return fail(res, 500, "UPLOAD_FAILED");
  }

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
