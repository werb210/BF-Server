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
import { resolveUploadCategory } from "./uploadCategory.js";
import { getStorage } from "../lib/storage/index.js";
import { enqueueOcrForDocument } from "../modules/ocr/ocr.service.js";
import { computeOutstandingDocs } from "./clientDocumentsNeeded.js"; // BF_SERVER_SHARED_DOCS_GATE_v1
import { requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
// BF_SERVER_BLOCK_v215_BF_TO_BI_DOC_MIRROR_v1
import { mirrorDocToBiAsync } from "../services/biDocMirror.js";
import { setProcessingStage } from "../modules/applications/processingStage.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// BF_SERVER_SHARED_DOCS_v1 — a document required by more than one linked
// application leg should only be uploaded once. After a doc lands on one leg,
// mirror it (same stored blob, no re-upload) to every sibling leg in the same
// family that REQUIRES the same category and does not already have it. Each
// mirror is enqueued for OCR so that leg's own analysis works. Best-effort.
async function mirrorDocToSiblingLegs(args: {
  applicationId: string;
  category: string;
  fileName: string;
  hash: string;
  blobName: string;
  url: string;
  sizeBytes: number;
  uploadedBy?: string | null;
}): Promise<void> {
  const category = String(args.category ?? "").trim();
  if (!category || category.toLowerCase() === "other") return;
  const fam = await pool.query<{ id: string; is_companion: boolean }>(
    `WITH root AS (
       SELECT COALESCE(parent_application_id, id) AS root_id
         FROM applications WHERE id::text = ($1)::text
     )
     SELECT a.id,
            COALESCE((a.metadata->>'closing_cost_companion')::boolean, false) AS is_companion
       FROM applications a, root r
      WHERE (a.id::text = (r.root_id)::text OR a.parent_application_id::text = (r.root_id)::text)
        AND a.id::text <> ($1)::text`,
    [args.applicationId],
  );
  for (const sib of fam.rows) {
    const sibId = String(sib.id);
    // BF_SERVER_SHARED_DOCS_COMPANION_ALL_v1 - a closing-cost companion is the SAME
    // borrower and SAME underlying deal as its parent, so it must receive the parent's
    // documents regardless of its own required set. That set is almost always empty on a
    // freshly-spawned companion (created at wizard step 2, before any product match), which
    // is why the requirement gate below silently skipped companions and left their
    // Documents tab at 0. For companions, mirror unconditionally; for any other linked leg,
    // keep the requirement-aware gate so we do not over-share across different products.
    let needs = sib.is_companion === true;
    // BF_SERVER_SHARED_DOCS_GATE_v1 — document_requirements is essentially never
    // populated; the live required-docs source is product metadata / matched-product
    // fallbacks. Gate on computeOutstandingDocs (required-minus-uploaded): the sibling
    // needs this category iff it appears in its outstanding set.
    if (!needs) {
      try {
        // BF_SERVER_SHARED_DOCS_ALL_FILES_v1 - gate on the FULL required set, not the
        // outstanding set. Outstanding is satisfied after the first shared file, which
        // dropped FS (and any multi-file category) to 1-of-N on linked legs.
        const { required } = await computeOutstandingDocs(sibId);
        const want = category.toLowerCase();
        needs = required.some((d) => String(d.document_type ?? "").trim().toLowerCase() === want);
      } catch { needs = false; }
    }
    if (!needs) continue;
    // Idempotent share: skip if this exact file (by hash) already exists on the sibling.
    const dup = await pool.query(
      `SELECT 1 FROM documents WHERE application_id::text = ($1)::text AND hash = $2 LIMIT 1`,
      [sibId, args.hash],
    ).catch(() => ({ rows: [] as any[] }));
    if (dup.rows.length > 0) continue;
    const newDocId = randomUUID();
    const newVerId = randomUUID();
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category,
            storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, document_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploaded','pending',$10,$5,now(),now())`,
        [newDocId, sibId, args.fileName, args.hash, category,
         args.blobName, args.blobName, args.url, args.sizeBytes,
         args.uploadedBy ?? "client"],
      );
      await tx.query(
        `INSERT INTO document_versions
           (id, document_id, version, blob_name, hash, metadata, content, created_at)
         VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
        [newVerId, newDocId, args.blobName, args.hash,
         JSON.stringify({ sharedFromApplicationId: args.applicationId }), args.url],
      );
      await tx.query("COMMIT");
    } catch {
      await tx.query("ROLLBACK").catch(() => undefined);
      tx.release();
      continue;
    }
    tx.release();
    try { await enqueueOcrForDocument(newDocId); } catch { /* best-effort */ }
  }
}

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
    // BF_SERVER_BLOCK_v818_OTHER_SKIP_OCR — "Other" docs are not OCR'd; they still reach the
    // lender package through the normal Accept flow (the package includes any accepted doc).
    const isOtherDoc = String(opts.category ?? "").trim().toLowerCase() === "other";
    await tx.query("BEGIN");

    await tx.query(
      // BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1
      `INSERT INTO documents
         (id, application_id, filename, hash, category,
          storage_path, blob_name, blob_url, size_bytes,
          status, ocr_status, uploaded_by, document_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'uploaded',$11,$10,$5,now(),now())`, // BF_SERVER_BLOCK_v818_OTHER_SKIP_OCR
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
        isOtherDoc ? 'skipped' : 'pending', // BF_SERVER_BLOCK_v818_OTHER_SKIP_OCR — $11
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

  // v629: clear banking_auto_skip when a new doc lands; pipeline can retry.
  try {
    await pool.query(
      `UPDATE applications
          SET metadata = COALESCE(metadata, '{}'::jsonb)
                       || jsonb_build_object('banking_auto_skip', false, 'banking_auto_zero_attempts', 0)
        WHERE id::text = ($1)::text
          AND COALESCE((metadata->>'banking_auto_skip')::boolean, false) = true`,
      [opts.applicationId],
    );
  } catch {
    // non-fatal
  }

  // BF_SERVER_SHARED_DOCS_v1 — share this doc across linked legs that require it.
  try {
    await mirrorDocToSiblingLegs({
      applicationId: String(opts.applicationId),
      category: String(opts.category),
      fileName: opts.file.originalname,
      hash: put.hash,
      blobName: put.blobName,
      url: put.url,
      sizeBytes: put.sizeBytes,
      uploadedBy: opts.uploadedBy ?? null,
    });
  } catch (err) {
    console.warn("[documents] sibling-leg share failed", { applicationId: opts.applicationId, err: String(err) });
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
  // BF_SERVER_BLOCK_v818_OTHER_SKIP_OCR — never OCR "Other" docs.
  if (String(opts.category ?? "").trim().toLowerCase() !== "other") {
    try {
      await enqueueOcrForDocument(documentId);
    } catch (err) {
      console.warn("[documents] OCR enqueue failed", { documentId, err: String(err) });
    }
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
  const category      = resolveUploadCategory(req.body) ?? ""; // BF_SERVER_BLOCK_v843 — accept category | document_type | documentType
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
  // BF_SERVER_MIME_DOT_SUFFIX_v1 - docx/xlsx/pptx mimes continue the allowed
  // "application/vnd.openxmlformats-officedocument" prefix with a DOT
  // (".wordprocessingml.document"), which the ";"/"/" separators never matched,
  // so every Word/Excel upload 415ed despite the allowlist intending them.
  const mimeAllowed = ALLOWED_MIME_PREFIXES.some((p) => mime === p || mime.startsWith(p + ";") || mime.startsWith(p + "/") || mime.startsWith(p + "."));
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
  const category      = resolveUploadCategory(req.body); // BF_SERVER_BLOCK_v843 — accept category | document_type | documentType
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!applicationId || !category || !file) return fail(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");
  try {
    const userId = (req as any)?.user?.id ?? null;
    const r = await persistAndEnqueue({ applicationId, category, file, uploadedBy: userId });
    // #7 — a received document advances the stage into review (Option A: on received,
    // not only when every doc is accepted). Non-fatal; never block the upload response.
    try {
      const appRes = await pool.query<{ processing_stage: string | null }>(
        `SELECT processing_stage FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId],
      );
      const stage = appRes.rows[0]?.processing_stage ?? null;
      if (stage === "documents_incomplete") {
        await setProcessingStage({
          applicationId,
          toStage: "documents_complete",
          reason: "document_received",
          actorUserId: userId,
        });
      }
    } catch (err) {
      console.error("[documents] auto-advance on received failed", { applicationId, err: String(err) });
    }
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
  const docRes = await pool.query<{ application_id: string | null }>(`SELECT application_id FROM documents WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] as any[] }));
  const applicationId = docRes.rows[0]?.application_id ?? null;
  if (applicationId) {
    const appRes = await pool.query<{ processing_stage: string | null; previous_processing_stage: string | null }>(`SELECT processing_stage, previous_processing_stage FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]).catch(() => ({ rows: [] as any[] }));
    const app = appRes.rows[0];
    if (app?.processing_stage === "documents_incomplete") {
      const unresolved = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM documents WHERE application_id::text = ($1)::text AND status='rejected'`, [applicationId]).catch(() => ({ rows: [{ count: 0 }] as any[] }));
      if ((unresolved.rows[0]?.count ?? 0) === 0 && app.previous_processing_stage) {
        await setProcessingStage({ applicationId, toStage: app.previous_processing_stage as any, reason: "all_documents_resolved", actorUserId: (req as any)?.user?.id ?? null }).catch(() => {});
      }
    }
  }
  return ok(res, { id, status: "accepted" });
});

router.post("/:id/reject", requireAuth, async (req: Request, res: Response) => {
  const id = toStringSafe(req.params.id);
  await pool.query(`UPDATE documents SET status='rejected', updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  const docRes = await pool.query<{ application_id: string | null }>(`SELECT application_id FROM documents WHERE id=$1 LIMIT 1`, [id]).catch(() => ({ rows: [] as any[] }));
  const applicationId = docRes.rows[0]?.application_id ?? null;
  if (applicationId) {
    await setProcessingStage({ applicationId, toStage: "documents_incomplete", reason: `document_rejected:${id}`, actorUserId: (req as any)?.user?.id ?? null }).catch(() => {});
  }
  return ok(res, { id, status: "rejected" });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.delete(
  "/:applicationId/documents/:documentId",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: Request, res: Response) => {
    const applicationId = String(req.params.applicationId ?? "").trim();
    const documentId = String(req.params.documentId ?? "").trim();
    if (!UUID_RE.test(applicationId) || !UUID_RE.test(documentId)) {
      return fail(res, 400, "INVALID_ID");
    }

    const exists = await pool.query<{ ok: number }>(
      `SELECT 1 AS ok FROM documents WHERE id = $1 AND application_id::text = $2 LIMIT 1`,
      [documentId, applicationId]
    );
    if (!exists.rows[0]) return fail(res, 404, "DOCUMENT_NOT_FOUND");

    // #8 — delete the blob first so storage is not orphaned on row removal.
    const blobRow = await pool.query<{ blob_name: string | null }>(
      `SELECT blob_name FROM documents WHERE id = $1 LIMIT 1`,
      [documentId]
    );
    const blobName = blobRow.rows[0]?.blob_name ?? null;
    if (blobName) {
      try {
        await getStorage().delete(blobName);
      } catch (err) {
        console.error("document_blob_delete_failed", { documentId, blobName, err });
      }
    }

    await pool.query(`DELETE FROM documents WHERE id = $1`, [documentId]);

    const hasEvents = await pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'document_events'
       ) AS present`
    ).catch(() => ({ rows: [{ present: false }] }));

    if (hasEvents.rows[0]?.present) {
      const actor = String((req as any)?.user?.email ?? "unknown");
      await pool.query(
        `INSERT INTO document_events (id, document_id, application_id, event, actor, created_at)
         VALUES (gen_random_uuid(), $1, $2::uuid, 'deleted', $3, now())`,
        [documentId, applicationId, actor]
      ).catch(() => {});
    }

    return res.status(200).json({ ok: true, id: documentId, applicationId });
  })
);

export default router;
