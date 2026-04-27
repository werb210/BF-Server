import { Router } from 'express';
import { requireAuth, requireCapability } from '../../middleware/auth.js';
import { CAPABILITIES } from '../../auth/capabilities.js';
import { pool } from '../../db.js';
import { isPipelineState } from './pipelineState.js';
import { transitionPipelineState } from './applications.service.js';
import { AppError } from '../../middleware/errors.js';
import { safeHandler } from '../../middleware/safeHandler.js';
import { getSilo } from '../../middleware/silo.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.APPLICATION_READ]));

// GET /api/applications — portal pipeline list
router.get('/', safeHandler(async (req: any, res: any) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const stage = req.query.stage as string | undefined;
  const includeDrafts = String((req.query as any)?.include_drafts ?? "") === "1";
  // Silo resolution: respects X-Silo header (portal + iOS), ?silo query, body.silo, then default BF.
  const { getSilo } = await import("../../middleware/silo.js");
  const silo = getSilo(res);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (stage) { conditions.push(`a.pipeline_state = $${idx++}`); params.push(stage); }
  if (silo)  { conditions.push(`a.silo = $${idx++}`);            params.push(silo); }
  if (!includeDrafts) {
    conditions.push(`NOT (
      lower(coalesce(a.metadata->>'isDraft', 'false')) = 'true'
      OR (
        lower(trim(coalesce(a.name, ''))) in ('', 'draft', 'draft application')
        AND lower(coalesce(a.pipeline_state, '')) in ('received', 'draft', 'new')
      )
    )`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const [data, count] = await Promise.all([
    pool.query(
      `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
              a.requested_amount, a.lender_id, a.lender_product_id,
              a.owner_user_id, a.source, a.created_at, a.updated_at,
              a.metadata, a.processing_stage, a.current_stage,
              a.silo, a.ocr_completed_at, a.banking_completed_at
       FROM applications a ${where}
       ORDER BY a.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, pageSize, offset]
    ),
    pool.query(
      `SELECT COUNT(*) AS total FROM applications a ${where}`,
      params
    ),
  ]);

  const applications = Array.isArray(data.rows) ? data.rows : [];

  res.json({
    status: 'ok',
    data: {
      applications,
      total: Number(count.rows[0]?.total ?? 0),
      page,
      pageSize,
    },
  });
}));

// GET /api/applications/:id — single application with documents
router.get('/:id', safeHandler(async (req: any, res: any) => {
  const result = await pool.query(
    `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
            a.requested_amount, a.lender_id, a.lender_product_id,
            a.owner_user_id, a.source, a.created_at, a.updated_at,
            a.metadata, a.processing_stage, a.current_stage,
            a.silo, a.ocr_completed_at, a.banking_completed_at
     FROM applications a WHERE a.id = $1`,
    [req.params.id]
  );

  const application = result.rows[0];
  if (!application) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (application.silo && silo && application.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  const docs = await pool.query(
    `SELECT d.id, d.application_id, d.document_category, d.status,
            d.created_at, d.updated_at,
            dv.id AS version_id, dv.filename, dv.blob_name,
            dv.size_bytes, dv.created_at AS uploaded_at,
            dv.status AS version_status
     FROM application_required_documents d
     LEFT JOIN document_versions dv
       ON dv.document_id = d.id AND dv.is_active = true
     WHERE d.application_id = $1
     ORDER BY d.created_at ASC`,
    [req.params.id]
  );

  res.json({ status: 'ok', data: { application, documents: docs.rows } });
}));

router.patch('/:id', safeHandler(async (req: any, res: any) => {
  const applicationId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  if (!applicationId) {
    throw new AppError('validation_error', 'Application id is required.', 400);
  }

  const existing = await pool.query<{ id: string; silo: string | null }>(
    `SELECT id, silo FROM applications WHERE id = $1 LIMIT 1`,
    [applicationId]
  );
  const found = existing.rows[0];
  if (!found) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const silo = getSilo(res);
  if (found.silo && silo && found.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  const stage = typeof req.body?.stage === 'string' ? req.body.stage.trim() : null;
  if (stage) {
    if (!isPipelineState(stage)) {
      throw new AppError('validation_error', `Invalid stage: ${stage}`, 400);
    }

    await transitionPipelineState({
      applicationId,
      nextState: stage,
      actorUserId: req.user?.userId ?? req.user?.id ?? 'system',
      actorRole: req.user?.role ?? null,
      trigger: 'portal_drag',
    });

    res.status(200).json({
      status: 'ok',
      data: { applicationId, stage },
    });
    return;
  }

  const allowedFields = ['name', 'requested_amount', 'metadata', 'current_step'];
  const updates: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (req.body?.[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(200).json({ status: 'ok', data: { applicationId } });
    return;
  }

  const setClauses = Object.keys(updates)
    .map((key, i) => `${key} = $${i + 2}`)
    .join(', ');

  await pool.query(
    `UPDATE applications SET ${setClauses}, updated_at = now() WHERE id = $1`,
    [applicationId, ...Object.values(updates)]
  );

  res.status(200).json({ status: 'ok', data: { applicationId } });
}));


router.delete('/:id', requireAdmin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const { rowCount } = await pool.query(`DELETE FROM applications WHERE id = $1`, [id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
}));

router.get("/:id/contacts", safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const { rows } = await pool.query(
    `SELECT ac.contact_id,
            ac.role,
            json_build_object(
              'first_name', c.first_name,
              'last_name', c.last_name,
              'email', c.email,
              'phone', c.phone,
              'is_primary_applicant', c.is_primary_applicant
            ) AS contact
     FROM application_contacts ac
     JOIN contacts c ON c.id = ac.contact_id
     WHERE ac.application_id = $1
     ORDER BY ac.created_at ASC`,
    [applicationId]
  );
  res.json({ data: rows });
}));


// GET /api/applications/:id/details — flat shape for portal drawer
router.get('/:id/details', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
            a.requested_amount, a.metadata, a.processing_stage,
            a.current_stage, a.silo, a.created_at, a.updated_at
       FROM applications a WHERE a.id = $1`,
    [id]
  );
  const app = result.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);

  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  // BF_DETAILS_FORMDATA_FALLBACK_v33 — Block 33: also read from
  // metadata.formData (the wizard's full app blob persisted by /submit)
  // so any field not promoted to a top-level metadata key still surfaces.
  const md = (app.metadata && typeof app.metadata === 'object')
    ? app.metadata as Record<string, any>
    : {};
  const fd = (md.formData && typeof md.formData === 'object')
    ? md.formData as Record<string, any>
    : {};

  const details = {
    id: app.id,
    applicant: app.name,
    status: app.status,
    stage: app.pipeline_state,
    submittedAt: md?.submittedAt ?? app.created_at,
    overview: {
      name: app.name,
      productType: app.product_type,
      requestedAmount: app.requested_amount,
      productCategory:
        md?.application?.productCategory ??
        md?.product_category ??
        fd?.productCategory ??
        fd?.product_category ??
        null,
    },
    kyc: md?.borrower ?? md?.kyc_responses ?? md?.kyc ?? fd?.kyc ?? fd?.financialProfile ?? null,
    applicantDetails: md?.borrower ?? md?.applicant ?? fd?.applicant ?? null,
    applicantInfo: md?.borrower ?? md?.applicant ?? fd?.applicant ?? null,
    businessDetails: md?.company ?? md?.business ?? fd?.business ?? null,
    business: md?.company ?? md?.business ?? fd?.business ?? null,
    owners: Array.isArray(md?.owners)
      ? md.owners
      : (md?.partner ? [md.partner]
         : md?.applicant?.partner ? [md.applicant.partner]
         : fd?.applicant?.partner ? [fd.applicant.partner]
         : []),
    financialProfile: md?.financials ?? md?.kyc ?? fd?.kyc ?? fd?.financialProfile ?? null,
    fundingRequest: {
      amount: app.requested_amount,
      productCategory: md?.application?.productCategory ?? md?.product_category ?? fd?.productCategory ?? null,
    },
    productCategory: md?.application?.productCategory ?? md?.product_category ?? fd?.productCategory ?? null,
    documents: Array.isArray(md?.documents) ? md.documents : null,
    rawPayload: md,
  };

  res.json({ status: 'ok', data: details });
}));

// GET /api/applications/:id/audit — drawer audit timeline tab
router.get('/:id/audit', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const appRow = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id = $1`,
    [id]
  );
  if (!appRow.rows[0]) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  const appSilo = appRow.rows[0].silo;
  if (appSilo && silo && appSilo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  const result = await pool.query(
    `SELECT id, event_type AS type, created_at AS "createdAt",
            actor, payload AS detail
       FROM application_audit_events
      WHERE application_id = $1
      ORDER BY created_at DESC
      LIMIT 200`,
    [id]
  ).catch(() => ({ rows: [] }));

  res.json({ status: 'ok', data: result.rows });
}));

router.post('/:id/send', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const { lenders } = (req.body ?? {}) as { lenders?: string[] };
  if (!Array.isArray(lenders) || lenders.length === 0) {
    throw new AppError('validation_error', 'lenders array is required.', 400);
  }

  const appRow = await pool.query(
    `SELECT id, silo FROM applications WHERE id = $1`,
    [id]
  );
  if (!appRow.rows[0]) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (appRow.rows[0].silo && silo && appRow.rows[0].silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  const { sendApplicationToLenders } = await import(
    '../../modules/lender/lender.service.js'
  ).catch(() => ({ sendApplicationToLenders: null as any }));

  if (typeof sendApplicationToLenders !== 'function') {
    throw new AppError(
      'not_implemented',
      'Lender send service is not available.',
      501
    );
  }

  const result = await sendApplicationToLenders({
    applicationId: id,
    lenderIds: lenders,
    actor: req.user?.userId ?? null,
  });

  res.json({ status: 'ok', data: result });
}));

export default router;
