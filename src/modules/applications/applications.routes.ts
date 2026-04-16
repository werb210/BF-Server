import { Router } from 'express';
import { requireAuth, requireCapability } from '../../middleware/auth.js';
import { CAPABILITIES } from '../../auth/capabilities.js';
import { pool } from '../../db.js';
import { isPipelineState } from './pipelineState.js';
import { transitionPipelineState } from './applications.service.js';
import { AppError } from '../../middleware/errors.js';
import { safeHandler } from '../../middleware/safeHandler.js';

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.APPLICATION_READ]));

// GET /api/applications — portal pipeline list
router.get('/', safeHandler(async (req: any, res: any) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const stage = req.query.stage as string | undefined;
  const silo = req.query.silo as string | undefined;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (stage) { conditions.push(`a.pipeline_state = $${idx++}`); params.push(stage); }
  if (silo)  { conditions.push(`a.silo = $${idx++}`);            params.push(silo); }

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

  res.json({
    status: 'ok',
    data: {
      applications: data.rows,
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

export default router;
