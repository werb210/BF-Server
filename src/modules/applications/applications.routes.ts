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
// BF_APP_LENDERS_ENDPOINT_v42 — Block 42-A
import { matchLenders, type LenderMatch } from '../../ai/lenderMatchEngine.js';
// BF_APP_ID_CAST_v39 — Block 39-A — applications.id comparisons cast to text

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
     FROM applications a WHERE a.id::text = ($1)::text`,
    [req.params.id]
  );

  const application = result.rows[0];
  if (!application) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (application.silo && silo && application.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  // BF_APP_DOCS_TYPE_SAFE_v41 — Block 41-A — applications.routes:GET /:id docs query
  // Old query joined document_versions.document_id (TEXT) to
  // application_required_documents.id (UUID) — Postgres rejected with
  // "operator does not exist: text = uuid" (42883). The old query also
  // selected columns that don't exist on document_versions (is_active,
  // filename, blob_name, size_bytes, status, updated_at). Replace with a
  // select-only-from-application_required_documents query using real columns,
  // and swallow any future schema drift to documents=[] instead of a 500.
  let docRows: any[] = [];
  try {
    const docsResult = await pool.query(
      `SELECT d.id::text                AS id,
              d.application_id          AS application_id,
              d.document_category       AS document_category,
              d.status                  AS status,
              d.created_at              AS created_at,
              d.created_at              AS updated_at,
              NULL::text                AS version_id,
              NULL::text                AS filename,
              NULL::text                AS blob_name,
              NULL::int                 AS size_bytes,
              d.created_at              AS uploaded_at,
              NULL::text                AS version_status
         FROM application_required_documents d
        WHERE d.application_id::text = ($1)::text
        ORDER BY d.created_at ASC`,
      [req.params.id]
    );
    docRows = Array.isArray(docsResult.rows) ? docsResult.rows : [];
  } catch (err: any) {
    // Defensive: log and serve [] so the drawer does not 500 if the schema
    // drifts again. Real fields will appear once the docs pipeline lands.
    // eslint-disable-next-line no-console
    console.warn('applications.detail.docs_query_failed', {
      applicationId: req.params.id,
      message: err?.message,
      code: err?.code,
    });
    docRows = [];
  }

  res.json({ status: 'ok', data: { application, documents: docRows } });
}));

router.patch('/:id', safeHandler(async (req: any, res: any) => {
  const applicationId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
  if (!applicationId) {
    throw new AppError('validation_error', 'Application id is required.', 400);
  }

  const existing = await pool.query<{ id: string; silo: string | null }>(
    `SELECT id, silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
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
    `UPDATE applications SET ${setClauses}, updated_at = now() WHERE id::text = ($1)::text`,
    [applicationId, ...Object.values(updates)]
  );

  res.status(200).json({ status: 'ok', data: { applicationId } });
}));


router.delete('/:id', requireAdmin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const { rowCount } = await pool.query(`DELETE FROM applications WHERE id::text = ($1)::text`, [id]);
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


// BF_BANKING_ANALYSIS_API_v52 — Bug 5 server-side. Aggregates banking signals
// available in V1 from applications.banking_completed_at + documents counts.
// Shape matches BF-portal's typed BankingAnalysis interface (src/api/banking.ts).
// Rich transaction-derived metrics return null in V1 (await OCR txn parsing).
router.get('/:id/banking-analysis', safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.id ?? '').trim();
  if (!applicationId) {
    throw new AppError('validation_error', 'Application id is required.', 400);
  }

  // Confirm the application exists; 404 cleanly when not.
  const appRes = await pool.query<{
    id: string;
    banking_completed_at: Date | null;
  }>(
    `SELECT id, banking_completed_at
       FROM applications
      WHERE id::text = ($1)::text
      LIMIT 1`,
    [applicationId]
  );
  if (!appRes.rows[0]) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const application = appRes.rows[0];

  // Aggregate documents by category + banking status.
  // Heuristic for "bank statement" docs: any doc whose effective category
  // (signed_category preferred, document_type fallback) contains 'bank'
  // case-insensitive.
  const docRes = await pool.query<{
    bank_total: string;
    bank_completed: string;
    any_completed: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE LOWER(COALESCE(signed_category, document_type, '')) LIKE '%bank%'
       )::text AS bank_total,
       COUNT(*) FILTER (
         WHERE LOWER(COALESCE(signed_category, document_type, '')) LIKE '%bank%'
           AND banking_status = 'completed'
       )::text AS bank_completed,
       COUNT(*) FILTER (WHERE banking_status = 'completed')::text AS any_completed
     FROM documents
     WHERE application_id::text = ($1)::text`,
    [applicationId]
  );
  const counts = docRes.rows[0] ?? { bank_total: '0', bank_completed: '0', any_completed: '0' };
  // BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING — pull rich analysis from banking_analyses + monthly summaries.
  const richRes = await pool.query<any>(`SELECT total_avg_monthly_deposits, average_daily_balance, negative_balance_days, total_deposits, total_withdrawals, average_monthly_nsfs, days_with_insufficient_funds, months_profitable_numerator, months_profitable_denominator, current_month_net_cash_flow, unusual_transactions, top_vendors, period_start, period_end, months_detected, accounts, status AS analysis_status, completed_at FROM banking_analyses WHERE application_id::text = ($1)::text`, [applicationId]);
  const monthlyRes = await pool.query<any>(`SELECT month_start::text AS month, total_deposits::text AS deposits, total_withdrawals::text AS withdrawals, net_cash_flow::text AS net, ending_balance::text AS ending_balance, nsf_count FROM banking_monthly_summaries WHERE application_id::text = ($1)::text ORDER BY month_start ASC`, [applicationId]);
  const rich = richRes.rows[0] ?? null;
  const monthly = monthlyRes.rows;
  const bankCount = Number(counts.bank_total) || 0;
  const completedBankCount = Number(counts.bank_completed) || 0;

  // Response shape mirrors BF-portal's BankingAnalysis interface. Optional
  // fields are populated when truthful, otherwise omitted/null. The portal
  // tab renders gracefully against this minimal payload in V1.
  const bankingCompletedAt = application.banking_completed_at
    ? application.banking_completed_at.toISOString()
    : null;

  return res.status(200).json({
    applicationId: application.id,
    bankingCompletedAt,
    banking_completed_at: bankingCompletedAt,
    bankCount,
    documentsAnalyzed: completedBankCount,
    monthsDetected: rich?.months_detected ?? null,
    monthGroups: monthly.map((m: any) => ({
      month: m.month,
      deposits: Number(m.deposits ?? 0),
      withdrawals: Number(m.withdrawals ?? 0),
      net: Number(m.net ?? 0),
      endingBalance: m.ending_balance == null ? null : Number(m.ending_balance),
      nsfCount: Number(m.nsf_count ?? 0),
    })),
    dateRange: rich ? { start: rich.period_start, end: rich.period_end } : null,
    accounts: rich?.accounts ?? [],
    inflows: rich ? {
      totalDeposits: rich.total_deposits == null ? null : Number(rich.total_deposits),
      averageMonthlyDeposits: rich.total_avg_monthly_deposits == null ? null : Number(rich.total_avg_monthly_deposits),
    } : null,
    outflows: rich ? {
      totalWithdrawals: rich.total_withdrawals == null ? null : Number(rich.total_withdrawals),
    } : null,
    cashFlow: rich ? {
      currentMonthNet: rich.current_month_net_cash_flow == null ? null : Number(rich.current_month_net_cash_flow),
      monthsProfitableNumerator: rich.months_profitable_numerator,
      monthsProfitableDenominator: rich.months_profitable_denominator,
    } : null,
    balances: rich ? {
      averageDailyBalance: rich.average_daily_balance == null ? null : Number(rich.average_daily_balance),
      negativeBalanceDays: rich.negative_balance_days,
    } : null,
    riskFlags: rich ? {
      averageMonthlyNsfs: rich.average_monthly_nsfs == null ? null : Number(rich.average_monthly_nsfs),
      daysWithInsufficientFunds: rich.days_with_insufficient_funds,
      unusualTransactions: rich.unusual_transactions ?? [],
    } : null,
    topVendors: rich?.top_vendors ?? [],
    status: rich?.analysis_status ?? (bankCount === 0
      ? 'no_bank_statements'
      : completedBankCount < bankCount
        ? 'analysis_in_progress'
        : 'analysis_complete'),
  });
}));

// GET /api/applications/:id/details — flat shape for portal drawer
router.get('/:id/details', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
            a.requested_amount, a.metadata, a.processing_stage,
            a.current_stage, a.silo, a.created_at, a.updated_at
       FROM applications a WHERE a.id::text = ($1)::text`,
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
    `SELECT silo FROM applications WHERE id::text = ($1)::text`,
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

// BF_APP_LENDERS_ENDPOINT_v42 — Block 42-A
// Real lender-matches endpoint. Replaces the placeholder consumed by the staff
// LendersTab. Reads application metadata, runs the match engine, and joins
// existing lender_submissions to enrich each match with submission status.
router.get('/:id/lenders', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);

  const appRes = await pool.query(
    `select id, metadata, requested_amount, product_category
       from applications
      where id::text = ($1)::text
      limit 1`,
    [appId],
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);

  const meta = (app.metadata && typeof app.metadata === 'object') ? (app.metadata as Record<string, any>) : {};
  // Tolerate every shape the wizard has saved over time.
  const requestedAmount = (() => {
    const raw = app.requested_amount ?? meta.requestedAmount ?? meta.amount ?? meta.fundingAmount ?? null;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  })();
  const country = (() => {
    const raw = String(meta.country ?? meta.businessCountry ?? '').trim().toUpperCase();
    if (raw === 'CA' || raw === 'CANADA') return 'CA' as const;
    if (raw === 'US' || raw === 'USA' || raw === 'UNITED STATES') return 'US' as const;
    return null;
  })();
  const province = typeof meta.province === 'string' ? meta.province : (typeof meta.state === 'string' ? meta.state : null);
  const industry = typeof meta.industry === 'string' ? meta.industry : null;
  const revenue  = (() => {
    const raw = meta.annualRevenue ?? meta.revenue ?? null;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  })();
  const timeInBusiness = (() => {
    const raw = meta.timeInBusinessMonths ?? meta.monthsInBusiness ?? meta.timeInBusiness ?? null;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : null;
  })();

  let matches: LenderMatch[] = [];
  try {
    matches = await matchLenders({
      requestedAmount,
      country,
      province,
      industry,
      revenue,
      timeInBusiness,
    });
  } catch (err: any) {
    // Defensive — never 500 the drawer because of a match-engine schema drift.
    // eslint-disable-next-line no-console
    console.warn('lenders.match_failed', { applicationId: appId, message: err?.message });
    matches = [];
  }

  // Decorate with submission state if a row exists.
  let submissionMap = new Map<string, { status: string; submittedAt: string | null }>();
  try {
    const subRes = await pool.query(
      `select lender_product_id, status, submitted_at
         from lender_submissions
        where application_id::text = ($1)::text`,
      [appId],
    );
    for (const r of subRes.rows as Array<{ lender_product_id: string; status: string; submitted_at: string | null }>) {
      if (r.lender_product_id) {
        submissionMap.set(String(r.lender_product_id), {
          status: r.status,
          submittedAt: r.submitted_at,
        });
      }
    }
  } catch { /* table shape drift — proceed without enrichment */ }

  const enriched = matches.map((m) => {
    const sub = submissionMap.get(m.id);
    return {
      ...m,
      // Aliases for legacy LenderTab consumers; harmless to include.
      matchPercentage: m.matchPercent,
      matchScore: m.matchPercent,
      submissionStatus: sub?.status ?? null,
      submittedAt: sub?.submittedAt ?? null,
    };
  });

  res.status(200).json(enriched);
}));

router.post('/:id/send', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const { lenders } = (req.body ?? {}) as { lenders?: string[] };
  if (!Array.isArray(lenders) || lenders.length === 0) {
    throw new AppError('validation_error', 'lenders array is required.', 400);
  }

  const appRow = await pool.query(
    `SELECT id, silo FROM applications WHERE id::text = ($1)::text`,
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

// BF_SERVER_BLOCK_v122c_DRAWER_TAB_ENDPOINTS_v1
// GET /api/applications/:id/documents — drawer Documents tab.
// Lazy-computes required-doc categories from the union of matching
// lender_products.required_documents JSONB, joined with actual uploads
// from the documents table. Returns the { categories: [...] } shape
// DocumentsTab.tsx expects.
router.get('/:id/documents', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  // BF_SERVER_BLOCK_v126a_CAPITAL_EQUIPMENT_FIXES_v1 — also fetch
  // parent_application_id and source so we can union parent's documents
  // when this is a C&E equipment leg (uploads land on parent only).
  const appRes = await pool.query<{ id: string; silo: string | null; requested_amount: any; metadata: any; parent_application_id: string | null; source: string | null; }>(
    `SELECT id, silo, requested_amount, metadata, parent_application_id, source FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [appId],
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const meta = (app.metadata && typeof app.metadata === 'object') ? (app.metadata as Record<string, any>) : {};
  const country = (() => {
    const raw = String(meta.country ?? meta.businessCountry ?? meta.kyc?.businessLocation ?? '').trim().toUpperCase();
    if (raw === 'CA' || raw === 'CANADA') return 'CA' as const;
    if (raw === 'US' || raw === 'USA' || raw === 'UNITED STATES') return 'US' as const;
    return null;
  })();
  const amount = (() => {
    const raw = app.requested_amount ?? meta.fundingAmount ?? meta.kyc?.fundingAmount ?? null;
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  })();
  const colsRes = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lender_products'`
  ).catch(() => ({ rows: [] as Array<{ column_name: string }> }));
  const cols = new Set(colsRes.rows.map((r) => r.column_name));
  let productRows: Array<{ required_documents: any; category: string | null }> = [];
  if (cols.has('required_documents')) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (cols.has('active')) where.push('active IS TRUE');
    if (cols.has('status')) where.push("(status IS NULL OR status = 'active')");
    if (country && cols.has('country')) {
      params.push(country);
      where.push(`(country IS NULL OR upper(country) = $${params.length})`);
    }
    const minCol = cols.has('amount_min') ? 'amount_min' : cols.has('min_amount') ? 'min_amount' : null;
    const maxCol = cols.has('amount_max') ? 'amount_max' : cols.has('max_amount') ? 'max_amount' : null;
    if (amount !== null && minCol) {
      params.push(amount);
      where.push(`(${minCol} IS NULL OR ${minCol} <= $${params.length})`);
    }
    if (amount !== null && maxCol) {
      params.push(amount);
      where.push(`(${maxCol} IS NULL OR ${maxCol} >= $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    try {
      const r = await pool.query(
        `SELECT required_documents, ${cols.has('category') ? 'category' : 'NULL::text AS category'} FROM lender_products ${whereSql}`,
        params,
      );
      productRows = r.rows as any[];
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn('documents.products_query_failed', { applicationId: appId, message: err?.message });
    }
  }
  const categoryMap = new Map<string, { key: string; label: string; required: boolean }>();
  for (const p of productRows) {
    const list = Array.isArray(p.required_documents) ? p.required_documents : [];
    for (const item of list) {
      const rawKey = (item && typeof item === 'object') ? (item.category ?? item.document_type ?? null) : null;
      if (!rawKey || typeof rawKey !== 'string') continue;
      const key = rawKey.trim();
      if (!key) continue;
      const required = Boolean(item?.required);
      const existing = categoryMap.get(key);
      categoryMap.set(key, { key, label: existing?.label ?? key, required: Boolean(existing?.required || required) });
    }
  }
  type FileRow = { id: string; filename: string | null; size_bytes: number | null; created_at: Date; status: string | null; category: string | null; };
  let fileRows: FileRow[] = [];
  try {
    const r = await pool.query<FileRow>(
      `SELECT d.id::text AS id, COALESCE(d.filename, d.title) AS filename, d.size_bytes AS size_bytes, d.created_at AS created_at, d.status AS status, COALESCE(d.category, d.document_type) AS category FROM documents d WHERE d.application_id::text = ($1)::text ORDER BY d.created_at ASC`,
      [appId],
    );
    fileRows = r.rows;
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.warn('documents.files_query_failed', { applicationId: appId, message: err?.message });
  }
  // BF_SERVER_BLOCK_v126a_CAPITAL_EQUIPMENT_FIXES_v1 — for C&E equipment
  // legs, also include parent's documents. The wizard uploads all docs
  // to the parent (capital) application; the equipment leg is created
  // by submit-time fan-out and has no docs of its own. Without this
  // union the equipment-leg drawer Documents tab shows zero files even
  // though the parent has them. Closing-costs companions are NOT unioned
  // here because they are categorically separate (different doc set).
  const isCapitalAndEquipmentLeg =
    app.parent_application_id &&
    (app.source === 'capital_and_equipment_leg' ||
     (meta as any)?.capital_and_equipment_leg === true ||
     (meta as any)?.leg_category === 'EQUIPMENT');
  if (isCapitalAndEquipmentLeg && app.parent_application_id) {
    try {
      const r = await pool.query<FileRow>(
        `SELECT d.id::text AS id, COALESCE(d.filename, d.title) AS filename, d.size_bytes AS size_bytes, d.created_at AS created_at, d.status AS status, COALESCE(d.category, d.document_type) AS category FROM documents d WHERE d.application_id::text = ($1)::text ORDER BY d.created_at ASC`,
        [app.parent_application_id],
      );
      const seenIds = new Set(fileRows.map((f) => f.id));
      for (const row of r.rows) {
        if (!seenIds.has(row.id)) fileRows.push(row);
      }
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn('documents.parent_files_query_failed', { applicationId: appId, parentId: app.parent_application_id, message: err?.message });
    }
  }
  const filesByCategory = new Map<string, FileRow[]>();
  const orphanFiles: FileRow[] = [];
  for (const f of fileRows) {
    const k = (f.category ?? '').trim();
    if (!k) { orphanFiles.push(f); continue; }
    if (!filesByCategory.has(k)) filesByCategory.set(k, []);
    filesByCategory.get(k)!.push(f);
  }
  const seen = new Set(categoryMap.keys());
  const categories: Array<{ key: string; label: string; required: boolean; files: Array<{ id: string; filename: string; size: number | null; uploadedAt: string | null; status: string; url: string | null; }>; }> = [];
  const fileToTab = (f: FileRow) => ({
    id: f.id,
    filename: f.filename ?? '',
    size: f.size_bytes,
    uploadedAt: f.created_at ? new Date(f.created_at as any).toISOString() : null,
    status: ((): 'accepted' | 'rejected' | 'pending_review' | 'required' => {
      const sv = String(f.status ?? '').toLowerCase();
      if (sv === 'accepted') return 'accepted';
      if (sv === 'rejected') return 'rejected';
      if (sv === 'required' || sv === 'missing') return 'required';
      return 'pending_review';
    })(),
    url: null,
  });
  for (const cat of categoryMap.values()) {
    const files = (filesByCategory.get(cat.key) ?? []).map(fileToTab);
    categories.push({ ...cat, files });
  }
  for (const [k, fs] of filesByCategory.entries()) {
    if (seen.has(k)) continue;
    categories.push({ key: k, label: k, required: false, files: fs.map(fileToTab) });
  }
  if (orphanFiles.length) {
    categories.push({ key: '__uncategorized', label: 'Uncategorized', required: false, files: orphanFiles.map(fileToTab) });
  }
  return res.json({ categories });
}));

// BF_SERVER_BLOCK_v122c_DRAWER_TAB_ENDPOINTS_v1
// GET/PATCH /api/applications/:id/financials — drawer Financials tab.
// Stub: returns structurally-correct EMPTY payload so the tab renders
// instead of crashing on 404. PATCH stores body under metadata.financials.
const EMPTY_FINANCIALS = {
  periods: [] as string[],
  summary: { id: 'summary', title: 'Financial Summary', lines: [] as any[] },
  pnl: { id: 'pnl', title: 'Profit & Loss', lines: [] as any[] },
  balance_sheet: { id: 'balance_sheet', title: 'Balance Sheet', lines: [] as any[] },
  cash_flow: { id: 'cash_flow', title: 'Cash Flow', lines: [] as any[] },
  debt: [] as any[],
  flags: [] as any[],
  ratios: { dscr: null, current_ratio: null, quick_ratio: null, debt_to_equity: null } as Record<string, number | null>,
};
router.get('/:id/financials', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  const r = await pool.query<{ silo: string | null; metadata: any }>(
    `SELECT silo, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [appId],
  );
  const app = r.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const meta = (app.metadata && typeof app.metadata === 'object') ? app.metadata as Record<string, any> : {};
  const stored = (meta.financials && typeof meta.financials === 'object') ? meta.financials : null;
  return res.json(stored ?? EMPTY_FINANCIALS);
}));
router.patch('/:id/financials', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  const r = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`, [appId],
  );
  const app = r.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  await pool.query(
    `UPDATE applications SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('financials', $1::jsonb), updated_at = NOW() WHERE id::text = ($2)::text`,
    [JSON.stringify(body), appId],
  );
  return res.json({ ok: true });
}));

// BF_SERVER_BLOCK_v122c_DRAWER_TAB_ENDPOINTS_v1
// POST /api/applications/:id/lenders/:lenderId/files — staff per-lender doc upload.
router.post('/:id/lenders/:lenderId/files', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  const lenderId = String(req.params.lenderId ?? '').trim();
  if (!appId || !lenderId) throw new AppError('validation_error', 'application id and lender id required.', 400);
  const appRes = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`, [appId],
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const filename = (req.body?.filename ?? req.file?.originalname ?? 'lender-upload') as string;
  const sizeBytes = Number(req.body?.size ?? req.file?.size ?? 0) || null;
  const docId = (typeof crypto !== 'undefined' && (crypto as any)?.randomUUID)
    ? (crypto as any).randomUUID() : `doc_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await pool.query(
    `INSERT INTO documents (id, application_id, owner_user_id, title, filename, size_bytes, category, status, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', 'staff', NOW()) ON CONFLICT (id) DO NOTHING`,
    [docId, appId, req.user?.id ?? req.user?.userId ?? null, filename, filename, sizeBytes, `lender:${lenderId}`],
  ).catch(() => {});
  return res.json({ ok: true, documentId: docId });
}));

export default router;
