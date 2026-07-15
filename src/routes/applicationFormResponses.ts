// BF_SERVER_BLOCK_TWO_STAGE_v1
// Application form responses -- read / upsert / submit for the
// post-submit digital forms (Stage 2 docs that have a form template
// on the client side: PNW and Debt Stack today).
//
// Mounted at /api/portal by the route registry.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { findOrCreateCompanyByNameAndSilo } from "../services/companies.js";
import { findOrCreateContactByEmailAndCompany } from "../services/contacts.js";
import { isCollateralFormDocType, buildCollateralFormPdfFromData } from "../pdf/collateralFormPdf.js";
import { attachRenderedFormDocument } from "../pdf/attachRenderedFormDocument.js";

const router: Router = Router();

// GET /applications/:id/form-responses
// Returns every form response the applicant has saved or submitted
// for this application. Used by the mini-portal's Stage 2 page to
// hydrate the form list.
router.get("/applications/:id/form-responses", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  try {
    const r = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id = $1
        ORDER BY updated_at DESC`,
      [appId],
    );
    return res.json({ items: r.rows });
  } catch (err) {
    console.error("[form_responses.list] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// GET /applications/:id/form-responses/:doc_type
// Returns a single form response. 404 if not yet started.
router.get("/applications/:id/form-responses/:doc_type", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  try {
    const r = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id = $1 AND doc_type = $2
        LIMIT 1`,
      [appId, docType],
    );
    if (r.rowCount === 0) {
      // BF_SERVER_BLOCK_v773_FORMRESP_EMPTY_OK: probing an optional form
      // (e.g. professional_advisors) before it's filled is not an error.
      return res.json({ item: null });
    }
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.get] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// PUT /applications/:id/form-responses/:doc_type
// Autosave. UPSERT into application_form_responses. Does NOT touch
// submitted_at -- saves keep the form in draft.
router.put("/applications/:id/form-responses/:doc_type", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  const data = req.body?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: "data must be an object" });
  }
  try {
    const r = await pool.query(
      `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (application_id, doc_type)
            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
      [appId, docType, JSON.stringify(data)],
    );
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.upsert] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

// POST /applications/:id/form-responses/:doc_type/submit
// Finalize. Sets submitted_at = NOW(). Idempotent: re-submit just
// updates the timestamp. data, if provided, overwrites the current
// row -- so the client can do save+submit in one call.
router.post("/applications/:id/form-responses/:doc_type/submit", requireAuth, async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const docType = String(req.params.doc_type);
  const data = req.body?.data;
  const hasData = data && typeof data === "object" && !Array.isArray(data);
  try {
    const r = hasData
      ? await pool.query(
          `INSERT INTO application_form_responses (application_id, doc_type, data, submitted_at, updated_at)
                VALUES ($1, $2, $3::jsonb, NOW(), NOW())
                ON CONFLICT (application_id, doc_type)
                DO UPDATE SET data = EXCLUDED.data, submitted_at = NOW(), updated_at = NOW()
             RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [appId, docType, JSON.stringify(data)],
        )
      : await pool.query(
          `UPDATE application_form_responses
              SET submitted_at = NOW(), updated_at = NOW()
            WHERE application_id = $1 AND doc_type = $2
            RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [appId, docType],
        );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: "not_found" });
    }
    // BF_SERVER_BLOCK_v726_FORM_TO_CRM_v1 — mirror contact/company details collected
    // in Stage-2 forms into the CRM (BF silo). professional_advisors -> one company
    // (the firm) + one contact (the person) per advisor, tagged by role. The contact
    // dedups by email/phone (v725). personal_net_worth -> enrich the application's
    // existing applicant contact with cell/email when those are missing.
    try {
      const SILO = "BF";
      const SENTINEL = "00000000-0000-0000-0000-000000000000";
      const formData: any = (r.rows[0] as any)?.data ?? data ?? {};
      if (docType === "professional_advisors") {
        const advisors: Record<string, any> = (formData?.advisors ?? {}) as Record<string, any>;
        const ROLE_TAG: Record<string, string> = {
          cpa: "Accountant/advisor",
          attorney: "Lawyer/advisor",
          insurance: "Insurance/advisor",
          ar_credit_insurance: "A/R Credit Insurance/advisor",
        };
        for (const key of Object.keys(ROLE_TAG)) {
          const row = (advisors[key] ?? {}) as Record<string, any>;
          const firm = String(row.firm ?? "").trim();
          const person = String(row.contact ?? "").trim();
          const email = String(row.email ?? "").trim();
          const phone = String(row.phone ?? "").trim();
          if (!firm && !person && !email && !phone) continue;
          let companyId: string | null = null;
          if (firm) {
            const co = await findOrCreateCompanyByNameAndSilo(pool, firm, SILO, { name: firm, silo: SILO });
            companyId = co.row.id;
          }
          const parts = (person || firm || "Advisor").split(/\s+/);
          const first = parts[0] ?? "Advisor";
          const last = parts.slice(1).join(" ");
          const { row: contact } = await findOrCreateContactByEmailAndCompany(
            pool,
            email,
            companyId ?? SENTINEL,
            SILO,
            { first_name: first, last_name: last, email: email || null, phone: phone || null, company_id: companyId, silo: SILO, role: "other" },
          );
          await pool.query(
            `UPDATE contacts
                SET tags = (SELECT array(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || $2::text[]))),
                    updated_at = now()
              WHERE id = $1`,
            [contact.id, [ROLE_TAG[key]]],
          );
        }
      } else if (docType === "personal_net_worth") {
        const f: Record<string, any> = (formData?.fields ?? formData ?? {}) as Record<string, any>;
        const cell = String(f.primary_cell ?? "").trim();
        const email = String(f.primary_email ?? "").trim();
        if (cell || email) {
          const appRes = await pool.query<{ contact_id: string | null }>(
            `SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1`,
            [appId],
          ).catch(() => ({ rows: [] as Array<{ contact_id: string | null }> }));
          const cid = appRes.rows[0]?.contact_id ?? null;
          if (cid) {
            await pool.query(
              `UPDATE contacts
                  SET phone = COALESCE(NULLIF(phone, ''), NULLIF($2, '')),
                      email = COALESCE(NULLIF(email, ''), NULLIF($3, '')),
                      updated_at = now()
                WHERE id = $1`,
              [cid, cell, email],
            );
          }
        }
      }
    } catch (mirrorErr: any) {
      console.warn("[form_responses.crm_mirror] failed", { appId, docType, message: mirrorErr?.message });
    }
    // BF_SERVER_BLOCK_v_COLLATERAL_FORM_PDFS_v1 - render the filled CMP collateral
    // form to a branded PDF and attach it to the Documents list (supersede prior
    // system copy). No SignNow. Best-effort: never fails the submit.
    try {
      if (isCollateralFormDocType(docType)) {
        const formData = (r.rows[0] as any)?.data ?? data ?? {};
        const pdf = await buildCollateralFormPdfFromData(docType, formData);
        await attachRenderedFormDocument(appId, docType, pdf);
      }
    } catch (attachErr: any) {
      console.warn("[form_responses.attach_pdf] failed", { appId, docType, message: attachErr?.message });
    }
    return res.json({ item: r.rows[0] });
  } catch (err) {
    console.error("[form_responses.submit] failed", err);
    return res.status(500).json({ error: "internal" });
  }
});

export default router;
