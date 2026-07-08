import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { eventBus } from "../events/eventBus.js";
// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — AUDIT-11 regression repair: stop
// public reads/writes on /api/offers, /api/offers/:id/status.
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import multer from "multer";
import { getStorage } from "../lib/storage/index.js";

// Replace each offer's document_url (a raw, non-public blob URL the browser
// cannot open) with a short-lived signed URL. Falls back to the stored value
// when there is no term-sheet blob or the backend cannot sign (e.g. local dev).
async function attachTermSheetUrls(rows: any[]): Promise<any[]> {
  if (!rows.length) return rows;
  const ids = rows.map((r) => String(r.id));
  const blobById = new Map<string, string>();
  try {
    const b = await runQuery(
      `select id::text as id, term_sheet_blob_name from offers where id::text = any($1::text[])`,
      [ids]
    );
    for (const r of b.rows as Array<{ id: string; term_sheet_blob_name: string | null }>) {
      if (r.term_sheet_blob_name) blobById.set(r.id, r.term_sheet_blob_name);
    }
  } catch { return rows; }
  const storage = getStorage();
  if (!storage.getSignedUrl) return rows;
  return Promise.all(
    rows.map(async (r) => {
      const blob = blobById.get(String(r.id));
      if (!blob) return r;
      const signed = await storage.getSignedUrl!(blob).catch(() => null);
      return signed ? { ...r, document_url: signed } : r;
    })
  );
}

const router = Router();

const offerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // Pre-fix, this returned offers for any application id (or the top 100
    // across silos when no filter was given). Match the portal silo
    // contract: filter by the caller's resolved silo, joining offers
    // through applications.silo. NULL applications.silo is treated as
    // belonging to the caller's silo so legacy un-tagged rows remain
    // accessible.
    const { getSilo } = await import("../middleware/silo.js");
    const callerSilo = getSilo(res) ?? null;
    const query = applicationId
      ? {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where o.application_id = $1
                   and ($2::text is null or a.silo is null or a.silo = $2::text)
                 order by o.updated_at desc`,
          values: [applicationId, callerSilo],
        }
      : {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where ($1::text is null or a.silo is null or a.silo = $1::text)
                 order by o.updated_at desc
                 limit 100`,
          values: [callerSilo],
        };
    const rows = await runQuery(query.text, query.values);
    const items = await attachTermSheetUrls(rows.rows);
    res.status(200).json({ items });
  })
);

router.post(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  offerUpload.single("file"),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lender = typeof req.body?.lender === "string" ? req.body.lender.trim() : "";
    if (!applicationId || !lender) {
      throw new AppError("validation_error", "applicationId and lender are required.", 400);
    }
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // Without this guard, staff in any silo could create an offer record
    // attached to an application in any other silo by knowing the UUID.
    // 404 rather than 403 to avoid leaking that the application exists in
    // another silo. Pattern mirrors v309 portal handlers.
    {
      const { getSilo } = await import("../middleware/silo.js");
      const callerSilo = getSilo(res);
      const owner = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId]
      );
      if (!owner.rows[0]) {
        throw new AppError("not_found", "Application not found.", 404);
      }
      const recordSilo = owner.rows[0].silo;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }

    // BF_SERVER_BLOCK_43_v1 -- field-name aliases. Portal sends
    // camelCase; legacy code paths or test fixtures may send snake_case
    // or short names. Accept all.
    const amount =
      req.body?.amount ?? null;
    const rateFactor =
      req.body?.rateFactor
      ?? req.body?.rate_factor
      ?? req.body?.rate
      ?? null;
    const term = req.body?.term ?? null;
    const paymentFrequency =
      req.body?.paymentFrequency
      ?? req.body?.payment_frequency
      ?? null;
    const expiry =
      req.body?.expiry
      ?? req.body?.expiry_date
      ?? null;

    // BF_SERVER_BLOCK_43_v1 -- upload the PDF if provided as
    // multipart "file"; otherwise accept a pre-supplied URL via
    // req.body.documentUrl / req.body.pdf for tests + legacy paths.
    let documentUrl: string | null =
      typeof req.body?.documentUrl === "string" ? req.body.documentUrl
      : typeof req.body?.pdf === "string" ? req.body.pdf
      : null;
    const uploaded = (req as any).file as
      | { buffer: Buffer; originalname: string; mimetype: string }
      | undefined;
    if (uploaded?.buffer?.length) {
      try {
        const store = getStorage();
        const put = await store.put({
          buffer: uploaded.buffer,
          filename: uploaded.originalname,
          contentType: uploaded.mimetype,
          pathPrefix: `offers/${applicationId}`,
        });
        documentUrl = put.url;
      } catch (err) {
        console.error("[offers] PDF upload failed", err);
        // Carry on without the URL rather than fail the whole POST.
        // Staff can re-upload by editing the offer record.
      }
    }

    const result = await runQuery(
      `insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created',$11,now(),now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [
        randomUUID(),
        applicationId,
        lender,
        amount,
        rateFactor,
        term,
        paymentFrequency,
        expiry,
        documentUrl,
        false,
        typeof req.body?.notes === "string" ? req.body.notes : null,
      ]
    );

    const offer = result.rows[0];
    if (!offer) {
      throw new AppError("create_failed", "Offer could not be created.", 500);
    }
    eventBus.emit("offer_created", { offerId: offer.id, applicationId });
    res.status(201).json({ offer });
  })
);

router.patch(
  "/:id/status",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
      throw new AppError("validation_error", "Valid status is required.", 400);
    }
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // PATCH /:id/status emits offer_accepted when status='accepted', which
    // has downstream side effects on the application (offer-acceptance
    // listener transitions pipeline_state). Without this guard, staff in
    // any silo could flip an offer's status on any application by knowing
    // the offer UUID. Use a JOIN-style WHERE so the WHERE clause itself
    // enforces silo, eliminating a separate guard query.
    const { getSilo } = await import("../middleware/silo.js");
    const callerSilo = getSilo(res) ?? null;

    const updated = await runQuery(
      `update offers
          set status = $2, updated_at = now()
        where id = $1
          and exists (
            select 1 from applications a
             where a.id::text = offers.application_id::text
               and ($3::text is null or a.silo is null or a.silo = $3::text)
          )
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [id, status, callerSilo]
    );
    const offer = updated.rows[0];
    if (!offer) throw new AppError("not_found", "Offer not found.", 404);

    if (status === "accepted") {
      eventBus.emit("offer_accepted", { offerId: id, applicationId: offer.application_id });
    }
    res.status(200).json({ offer });
  })
);

// Client requests changes to an offer: a flag + staff notification, NOT a
// decline and NOT a stage change. Keep the offer active so staff can follow up
// with the lender and re-issue.
router.post(
  "/:id/request-changes",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Offer id is required.", 400);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const { getSilo } = await import("../middleware/silo.js");
    const callerSilo = getSilo(res) ?? null;
    const updated = await runQuery(
      `update offers
          set status = 'changes_requested',
              notes = case when $3::text is null or $3::text = '' then notes else $3::text end,
              updated_at = now()
        where id = $1
          and exists (
            select 1 from applications a
             where a.id::text = offers.application_id::text
               and ($2::text is null or a.silo is null or a.silo = $2::text)
          )
       returning id, application_id, lender_name, status`,
      [id, callerSilo, reason || null]
    );
    const offer = updated.rows[0] as { id: string; application_id: string; lender_name: string | null } | undefined;
    if (!offer) throw new AppError("not_found", "Offer not found.", 404);
    try {
      const { notifyAllStaff } = await import("../services/notifications/notifyAllStaff.js");
      await notifyAllStaff({
        pool,
        notificationType: "offer_changes_requested",
        title: "Offer changes requested",
        body: `The client requested changes on the ${offer.lender_name ?? "lender"} offer${reason ? `: ${reason}` : "."}`,
        refTable: "offers",
        refId: id,
        silo: callerSilo ?? "BF",
      });
    } catch (e) { console.warn("[offers] request-changes notify failed", e instanceof Error ? e.message : String(e)); }
    eventBus.emit("offer_changes_requested", { offerId: id, applicationId: offer.application_id, reason });
    res.status(200).json({ ok: true, offer_id: id, status: "changes_requested" });
  })
);


// BF_SERVER_TERM_SHEET_STREAM_v1 - serve the term-sheet PDF through the API instead of
// handing the browser a raw/SAS blob URL. Fixes: SAS expiry, private-container 403s,
// and wrong Content-Type (Chrome renders an XML error as "Failed to load PDF document").
// Streams with the correct inline PDF headers and validates the %PDF- magic bytes.
router.get("/:id/term-sheet", requireAuth, safeHandler(async (req: any, res: any) => {
  const offerId = String(req.params.id);
  const row = await runQuery<{ term_sheet_blob_name: string | null; term_sheet_filename: string | null }>(
    `select term_sheet_blob_name, term_sheet_filename from offers where id::text = $1 limit 1`,
    [offerId],
  );
  const blobName = row.rows[0]?.term_sheet_blob_name ?? null;
  if (!blobName) return res.status(404).json({ error: "no_term_sheet" });
  const got = await getStorage().get(blobName).catch(() => null);
  if (!got?.buffer?.length) return res.status(404).json({ error: "blob_missing" });
  const isPdf = got.buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!isPdf) return res.status(422).json({ error: "not_a_pdf", storedContentType: got.contentType, sizeBytes: got.buffer.length });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${(row.rows[0]?.term_sheet_filename ?? "term-sheet.pdf").replace(/[^\w.\-]/g, "_")}"`);
  res.setHeader("Content-Length", String(got.buffer.length));
  res.setHeader("Cache-Control", "private, max-age=60");
  return res.end(got.buffer);
}));

// BF_SERVER_TERM_SHEET_STREAM_v1 - why a term sheet will not render. Reports whether the
// blob exists, its stored content type, size, and whether the bytes start with %PDF-.
router.get("/:id/term-sheet/diagnostics", requireAuth, safeHandler(async (req: any, res: any) => {
  const offerId = String(req.params.id);
  const row = await runQuery<{ term_sheet_blob_name: string | null; term_sheet_filename: string | null; document_url: string | null }>(
    `select term_sheet_blob_name, term_sheet_filename, document_url from offers where id::text = $1 limit 1`,
    [offerId],
  );
  const r = row.rows[0];
  if (!r) return res.status(404).json({ ok: false, error: "offer_not_found" });
  if (!r.term_sheet_blob_name) return res.json({ ok: false, diagnosis: "no_blob_name_on_offer", documentUrl: r.document_url });
  const got = await getStorage().get(r.term_sheet_blob_name).catch(() => null);
  if (!got?.buffer?.length) return res.json({ ok: false, diagnosis: "blob_missing_in_storage", blobName: r.term_sheet_blob_name });
  const head = got.buffer.subarray(0, 5).toString("latin1");
  const isPdf = head === "%PDF-";
  return res.json({
    ok: isPdf,
    diagnosis: isPdf ? "valid_pdf" : "stored_bytes_are_not_a_pdf",
    blobName: r.term_sheet_blob_name,
    filename: r.term_sheet_filename,
    storedContentType: got.contentType,
    sizeBytes: got.buffer.length,
    firstBytes: head,
  });
}));

export default router;
