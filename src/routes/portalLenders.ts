/**
 * Missing portal lender CRUD routes (GET /:id, POST, PATCH /:id, DELETE /:id).
 * The GET / list route already lives in portal.ts — this file adds the rest.
 * Mounted at /api/portal by routeRegistry.
 */
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { pool, runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { AppError } from "../middleware/errors.js";
import { getSilo } from "../middleware/silo.js";
import { mirrorLenderToCrm } from "../services/lenderCrmMirror.js"; // BF_LENDER_TO_CRM_v38
import {
  fetchLenderById,
  createLender,
  updateLender,
} from "../repositories/lenders.repo.js";
import { createLenderProduct } from "../repositories/lenderProducts.repo.js"; // BF_SERVER_BLOCK_v815_IMPORT_FROM_BI
import { fetchBiCompaniesByIds } from "../services/biCompanyFetch.js"; // BF_SERVER_BLOCK_v819_IMPORT_FROM_BI_VIA_API

const router = Router();
const uploadDir = "/tmp/lender-documents";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
  }),
});

// GET /api/portal/lenders/:id
// BF_SERVER_BLOCK_v133_PORTAL_LENDER_AUTH_v1 — AUDIT-8
router.get(
  "/lenders/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    const silo = getSilo(res);
    const lender = await fetchLenderById(id);
    if (lender && lender.silo && lender.silo !== silo) throw new AppError("not_found", "Lender not found.", 404);
    if (!lender) throw new AppError("not_found", "Lender not found.", 404);
    res.status(200).json(lender);
  })
);

// POST /api/portal/lenders
router.post(
  "/lenders",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const body = req.body ?? {};
    const silo = getSilo(res);
    if (!body.name || !body.country)
      throw new AppError("validation_error", "name and country are required.", 400);

    const lender = await createLender(pool, {
      name: body.name,
      country: body.country,
      submission_method: body.submissionMethod ?? body.submission_method ?? "EMAIL",
      active: body.active ?? true,
      status: body.status ?? "ACTIVE",
      email: body.email ?? null,
      primary_contact_name: body.primaryContactName ?? body.primary_contact_name ?? null,
      primary_contact_email: body.primaryContactEmail ?? body.primary_contact_email ?? null,
      primary_contact_phone: body.primaryContactPhone ?? body.primary_contact_phone ?? null,
      submission_email: body.submissionEmail ?? body.submission_email ?? null,
      api_config: body.apiConfig ?? body.api_config ?? null,
      submission_config: body.submissionConfig ?? body.submission_config ?? null,
      website: body.website ?? null,
      description: body.description ?? null, // BF_SERVER_LENDER_COMPANY_PARITY_v1
      application_url: body.application_url ?? null,
      announcement: body.announcement ?? null,
      street: body.street ?? body.address?.street ?? null,
      city: body.city ?? body.address?.city ?? null,
      region: body.region ?? body.address?.stateProvince ?? null,
      postal_code: body.postalCode ?? body.postal_code ?? body.address?.postalCode ?? null,
      phone: body.phone ?? null,
      silo,
    });
      // BF_LENDER_TO_CRM_v38 — fire-and-forget CRM mirror
      void mirrorLenderToCrm({
        id: lender.id,
        name: lender.name ?? null,
        phone: (lender as any).phone ?? null,
        silo: (lender as any).silo ?? null,
        country: (lender as any).country ?? null,
        contact_name: (lender as any).primary_contact_name ?? null,
        contact_email: (lender as any).primary_contact_email ?? null,
        contact_phone: (lender as any).primary_contact_phone ?? null,
      });
    res.status(201).json(lender);
  })
);

// PATCH /api/portal/lenders/:id
router.patch(
  "/lenders/:id",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    const body = req.body ?? {};
    const silo = getSilo(res);
    const existing = await fetchLenderById(id);
    if (!existing || (existing.silo && existing.silo !== silo)) throw new AppError("not_found", "Lender not found.", 404);
    const lender = await updateLender(pool, {
      id,
      name: body.name,
      status: body.status,
      country: body.country,
      email: body.email,
      submission_method: body.submissionMethod ?? body.submission_method,
      primary_contact_name: body.primaryContactName ?? body.primary_contact_name,
      primary_contact_email: body.primaryContactEmail ?? body.primary_contact_email,
      primary_contact_phone: body.primaryContactPhone ?? body.primary_contact_phone,
      submission_email: body.submissionEmail ?? body.submission_email,
      api_config: body.apiConfig ?? body.api_config,
      submission_config: body.submissionConfig ?? body.submission_config,
      website: body.website,
      webpage: body.webpage,
      application_url: body.application_url,
      announcement: body.announcement,
      active: body.active,
      // BF_SERVER_LENDER_EDIT_ADDRESS_v1 - staff edit modal sends address and
      // main phone; forward them so the repo can persist those PATCH edits.
      street: body.street ?? body.address?.street,
      city: body.city ?? body.address?.city,
      region: body.region ?? body.address?.stateProvince ?? body.address?.region,
      postal_code: body.postalCode ?? body.postal_code ?? body.address?.postalCode,
      phone: body.phone,
      description: body.description, // BF_SERVER_LENDER_COMPANY_PARITY_v1
      silo: body.silo ?? existing.silo ?? silo,
    });
      // BF_LENDER_TO_CRM_v38 — fire-and-forget CRM mirror on update
      void mirrorLenderToCrm({
        id: lender.id,
        name: lender.name ?? null,
        phone: (lender as any).phone ?? null,
        silo: (lender as any).silo ?? null,
        country: (lender as any).country ?? null,
        contact_name: (lender as any).primary_contact_name ?? null,
        contact_email: (lender as any).primary_contact_email ?? null,
        contact_phone: (lender as any).primary_contact_phone ?? null,
      });
    if (!lender) throw new AppError("not_found", "Lender not found.", 404);
    res.status(200).json(lender);
  })
);

router.post(
  "/lender-documents/:lenderId/upload",
  requireAuth,
  upload.single("file"),
  safeHandler(async (req: any, res: any) => {
    const lenderId = req.params.lenderId;
    const file = req.file;
    if (!file) {
      throw new AppError("validation_error", "file is required", 400);
    }

    const blobUrl = `file://${path.join(uploadDir, file.filename)}`;
    const { rows } = await pool.query(
      `INSERT INTO lender_documents (id, lender_id, filename, mime_type, blob_url, uploaded_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
       RETURNING *`,
      [
        lenderId,
        file.originalname,
        file.mimetype || "application/octet-stream",
        blobUrl,
        req.user?.userId ?? null,
      ]
    );

    const mayaUrl = process.env.MAYA_URL;
    if (mayaUrl) {
      await fetch(`${mayaUrl}/api/knowledge/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lenderId,
          filename: file.originalname,
          blobUrl,
          mimeType: file.mimetype || "application/octet-stream",
        }),
      }).catch(() => undefined);
    }

    res.status(201).json({ ok: true, data: rows[0] });
  })
);

router.get(
  "/lender-documents/:lenderId",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const { rows } = await pool.query(
      `SELECT id, lender_id, filename, mime_type, blob_url, uploaded_by, created_at
       FROM lender_documents
       WHERE lender_id = $1 AND silo = $2 -- BF_SERVER_BLOCK_v156_SILO_LEAK_FIX_v1
       ORDER BY created_at DESC`,
      [req.params.lenderId, getSilo(res)]
    );
    res.json({ ok: true, data: rows });
  })
);

// DELETE /api/portal/lenders/:id
router.delete(
  "/lenders/:id",
  requireAuth,
  requireAdmin,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "Lender id is required.", 400);
    const silo = getSilo(res);
    const userId = req.user?.id ?? req.user?.userId ?? null;
    try {
      await runQuery("DELETE FROM lenders WHERE id = $1 AND silo = $2" /* BF_SERVER_BLOCK_v156_SILO_LEAK_FIX_v1 */, [id, silo]);
      console.info({ event: "lender_deleted", lenderId: id, userId });
      // BF_PORTAL_REFRESH_AND_PARSE_v55_SERVER — return JSON body so the
      // portal's apiFetch can call res.json() without "Unexpected end of
      // JSON input". Status 200 + body matches the sibling PATCH handler.
      res.status(200).json({ ok: true, deleted: true, id });
    } catch (err: any) {
      console.error({
        event: "lender_delete_failed",
        lenderId: id,
        userId,
        code: err?.code,
        message: err?.message,
        detail: err?.detail,
      });
      res.status(500).json({ error: { message: "delete_failed", code: err?.code ?? "unknown" } });
    }
  })
);

// BF_SERVER_BLOCK_v815_IMPORT_FROM_BI — pull selected BI lender companies into the BF Lenders list.
// Fetches BI companies by id via BI-Server; creates a BF lender (+ CRM company via mirrorLenderToCrm)
// and a lender_product per Type Of Financing tag. Dedupe by lender name. Financing + country tags
// (CA/US) were written on bi_companies by the BI company importer (v814).
// BF_SERVER_BLOCK_v824_IMPORT_MAPPING_FIX — map each BI financing tag to the BF lender_product
// { category, name }. "Other" is intentionally ABSENT so it is skipped (never imported as a BF
// product). A/R LOC and LOC both map to "LOC" and are deduped in the loop below.
const BI_FINANCING_MAP: Record<string, { category: string; name: string }> = {
  "equipment financing": { category: "EQUIPMENT", name: "Equipment Financing" },
  factoring: { category: "FACTORING", name: "Factoring" },
  loc: { category: "LOC", name: "LOC" },
  "a/r loc": { category: "LOC", name: "LOC" },
  "wc/stl": { category: "TERM", name: "Term Loans" },
};

router.post(
  "/lenders/import-from-bi",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const rawIds = req.body?.companyIds ?? req.body?.company_ids;
    const ids: string[] = Array.isArray(rawIds)
      ? Array.from(
          new Set(rawIds.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0)),
        )
      : [];
    if (ids.length === 0) throw new AppError("validation_error", "companyIds is required.", 400);

    let lendersCreated = 0;
    let lendersSkipped = 0;
    let productsCreated = 0;
    const created: Array<{ company_id: string; lender_id: string; name: string }> = [];
    const skipped: Array<{ company_id: string; name: string; reason: string }> = [];

    // BF_SERVER_BLOCK_v819_IMPORT_FROM_BI_VIA_API — bi_companies lives in BI's
    // database; fetch over HTTP instead of querying a table BF cannot see.
    const biCompanies = await fetchBiCompaniesByIds(ids);
    const companyById = new Map<string, (typeof biCompanies)[number]>(
      biCompanies.map((company) => [company.id, company]),
    );

    for (const id of ids) {
      const c = companyById.get(id);
      if (!c) {
        skipped.push({ company_id: id, name: "", reason: "not_found" });
        lendersSkipped++;
        continue;
      }

      const name = (c.legal_name ?? "").trim();
      if (!name) {
        skipped.push({ company_id: c.id, name: "", reason: "missing_name" });
        lendersSkipped++;
        continue;
      }
      const tags = Array.isArray(c.tags) ? c.tags : [];
      const lower = tags.map((t) => String(t).toLowerCase());
      const country = lower.includes("ca") ? "CA" : "US";
      const financing = tags.filter(
        (t) => BI_FINANCING_MAP[String(t).toLowerCase()] !== undefined,
      );

      // BF_SERVER_BLOCK_v837_IMPORT_LENDER_SILO_SCOPED_DEDUP — scope the dedup to
      // the BF silo we actually create into. A cross-silo match was false-skipping
      // lenders (e.g. "Capitally") that don't exist in the BF list the user views.
      const exists = await pool.query<{ id: string }>(
        `SELECT id FROM lenders WHERE lower(name) = lower($1) AND COALESCE(silo,'BF') = 'BF' LIMIT 1`,
        [name],
      );
      if (exists.rows[0]) {
        skipped.push({ company_id: c.id, name, reason: "lender_exists" });
        lendersSkipped++;
        continue;
      }

      const pc = c.primary_contact ?? { full_name: null, email: null, phone_e164: null };

      let lender: Awaited<ReturnType<typeof createLender>>;
      try {
        lender = await createLender(pool, {
          name,
          country,
          submission_method: "EMAIL",
          submission_email: pc.email ?? null,
          active: true,
          status: "ACTIVE",
          website: c.website ?? null,
          phone: c.phone ?? null,
          city: c.city ?? null,
          region: c.province ?? null,
          postal_code: c.postal_code ?? null,
          primary_contact_name: pc.full_name ?? null,
          primary_contact_email: pc.email ?? null,
          primary_contact_phone: pc.phone_e164 ?? null,
          silo: "BF",
        });

        // BF_LENDER_TO_CRM_v38 — also create the BF CRM company.
        void mirrorLenderToCrm({
          id: lender.id,
          name: lender.name ?? null,
          phone: (lender as any).phone ?? null,
          silo: (lender as any).silo ?? "BF",
          country: (lender as any).country ?? null,
          contact_name: (lender as any).primary_contact_name ?? null,
          contact_email: (lender as any).primary_contact_email ?? null,
          contact_phone: (lender as any).primary_contact_phone ?? null,
        });

        const seenProducts = new Set<string>();
        for (const f of financing) {
          const m = BI_FINANCING_MAP[String(f).toLowerCase()];
          if (!m) continue; // "Other"/unmapped tags create no BF product
          if (seenProducts.has(m.name)) continue; // dedupe LOC (from both "LOC" and "A/R LOC")
          seenProducts.add(m.name);
          try {
            await createLenderProduct({
              lenderId: lender.id,
              name: m.name,
              active: true,
              category: m.category,
              requiredDocuments: [],
              country,
            });
            productsCreated++;
          } catch {
            // A single product failing must not abort the whole import.
          }
        }
      } catch (e: any) {
        // BF_SERVER_BLOCK_v819 — a unique/constraint failure on one company
        // (e.g. lender name collision) must not abort the whole import.
        const code = e?.code ? String(e.code) : "";
        const reason = code === "23505" ? "duplicate" : "create_failed";
        // Log the real DB error so import failures are diagnosable instead of
        // silently surfacing as a "skip (already exist)" in the UI.
        console.warn(JSON.stringify({
          event: "import_from_bi_create_failed",
          company_id: c.id, name, code,
          message: String(e?.message ?? "").slice(0, 300),
        }));
        skipped.push({ company_id: c.id, name, reason });
        lendersSkipped++;
        continue;
      }

      created.push({ company_id: c.id, lender_id: lender.id, name });
      lendersCreated++;
    }

    res.status(200).json({
      ok: true,
      lenders_created: lendersCreated,
      lenders_skipped: lendersSkipped,
      products_created: productsCreated,
      created,
      skipped,
    });
  }),
);

export default router;
