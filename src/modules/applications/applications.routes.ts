import { Router } from 'express';
import { requireAuth, requireCapability } from '../../middleware/auth.js';
import { CAPABILITIES } from '../../auth/capabilities.js';
import { pool } from '../../db.js';
import { isPipelineState } from './pipelineState.js';
import { transitionPipelineState } from './applications.service.js';
import { AppError } from '../../middleware/errors.js';
import { safeHandler } from '../../middleware/safeHandler.js';
import { computeOutstandingDocs } from '../../routes/clientDocumentsNeeded.js';
import { getSilo } from '../../middleware/silo.js';
import { requireAdmin } from '../../middleware/requireAdmin.js';
// BF_APP_LENDERS_ENDPOINT_v42 — Block 42-A
import { matchLenders, type LenderMatch } from '../../ai/lenderMatchEngine.js';
// BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
import { readLenderMatchEnvelope, computeAndCacheLenderMatches, readCachedMatchesArray } from '../../services/lenderMatchCache.js';
import multer from 'multer';
import { getStorage } from '../../lib/storage/index.js';
import { sendSMS } from '../../services/smsService.js';
import { randomUUID } from 'node:crypto';
// BF_APP_ID_CAST_v39 — Block 39-A — applications.id comparisons cast to text

const router = Router();
const lenderTermSheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });


router.get('/:publicId/required-documents', safeHandler(async (req: any, res: any) => {
  const publicId = String(req.params.publicId ?? '').trim();
  const appRes = await pool.query<{ id: string; product_type: string; requested_amount: number | null; metadata: unknown | null; lender_product_id: string | null }>(
    `SELECT id, product_type, requested_amount, metadata, lender_product_id
       FROM applications
      WHERE bi_public_id = $1
      LIMIT 1`,
    [publicId],
  );
  const app = appRes.rows[0];
  if (!app) return res.status(404).json({ error: 'not_found' });

  const { resolveRequirementsForApplication } = await import('../../services/lenderProductRequirementsService.js');
  const { normalizeRequiredDocumentKey } = await import('../../db/schema/requiredDocuments.js');
  const resolved = await resolveRequirementsForApplication({
    lenderProductId: app.lender_product_id,
    productType: app.product_type,
    requestedAmount: app.requested_amount,
    country: null,
  });
  const required = (resolved.requirements ?? []).filter((r: any) => r.required !== false);
  const keys = [...new Set(required.map((r: any) => normalizeRequiredDocumentKey(r.documentType)).filter(Boolean))] as string[];
  const docRes = await pool.query(`SELECT document_type AS doc_type, status, rejection_reason, created_at FROM documents WHERE application_id::text = ($1)::text ORDER BY created_at DESC`, [app.id]);
  const byType = new Map<string, any>();
  for (const row of docRes.rows as any[]) {
    const k = normalizeRequiredDocumentKey(row.doc_type);
    if (k && !byType.has(k)) byType.set(k, row);
  }
  const items = keys.map((k) => {
    const row = byType.get(k);
    const status = !row ? 'pending' : (row.status === 'accepted' || row.status === 'rejected' ? row.status : 'uploaded');
    return { doc_type: k, label: k, status, rejection_reason: row?.rejection_reason ?? undefined, last_uploaded_at: row?.created_at ?? undefined };
  });
  const rank:any = { rejected: 0, pending: 1, uploaded: 2, accepted: 3 };
  items.sort((a:any,b:any)=>rank[a.status]-rank[b.status]);
  res.json({ required: items, totalRequired: items.length, totalAccepted: items.filter((i:any)=>i.status==='accepted').length, totalRejected: items.filter((i:any)=>i.status==='rejected').length });
}));

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

router.get('/dup-debug', safeHandler(async (req: any, res: any) => {
  // BF_SERVER_BLOCK_v781_DUP_DEBUG — read-only. Lists applications matching a
  // name (business or contact) or a contactId, with the fields that tell a true
  // duplicate submission from an expected companion/child app. No writes.
  const q = String(req.query?.q ?? "").trim();
  const contactId = String(req.query?.contactId ?? "").trim();
  if (!q && !contactId) return res.status(400).json({ error: "provide ?q=<name> or ?contactId=<uuid>" });
  const cols = `a.id, a.name AS business_name, a.product_category, a.requested_amount,
                a.pipeline_state, a.source, a.parent_application_id, a.contact_id,
                a.created_at, a.submitted_at,
                c.name AS contact_name, c.email AS contact_email,
                right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) AS contact_phone_last10`;
  let rows: any[] = [];
  if (contactId) {
    const r = await pool.query(
      `SELECT ${cols} FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.contact_id::text = $1 ORDER BY a.created_at ASC`, [contactId]);
    rows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT ${cols} FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.name ILIKE $1 OR c.name ILIKE $1
        ORDER BY a.contact_id NULLS LAST, a.created_at ASC`, [`%${q}%`]);
    rows = r.rows;
  }
  const apps = rows.map((r) => ({
    id: r.id, idShort: String(r.id).slice(-8).toUpperCase(),
    business_name: r.business_name, contact_name: r.contact_name, contact_email: r.contact_email,
    contact_phone_last10: r.contact_phone_last10, contact_id: r.contact_id,
    product: r.product_category, amount: r.requested_amount, stage: r.pipeline_state,
    product_category: r.product_category, requested_amount: r.requested_amount,
    pipeline_state: r.pipeline_state, source: r.source,
    parent_application_id: r.parent_application_id,
    isCompanion: !!r.parent_application_id,
    submitted: !!r.submitted_at,
    created_at: r.created_at, submitted_at: r.submitted_at,
  }));
  return res.json({ query: q || contactId, count: apps.length, applications: apps });
}));

// BF_SERVER_BLOCK_v_TASK_DOCS_AUTHORITATIVE_v1 — the client's CMP reports "nothing
// outstanding" entirely from the live outstanding-docs computation. Make every
// document-upload task (bare 'upload' = Gov ID, and 'upload:<type>' re-uploads) read
// complete from that SAME signal so the staff Application tab can never disagree with
// what the client sees. While docs are still outstanding, fall back to per-category
// matching so a specific already-satisfied doc can still read complete mid-flight.
export function isDocUploadTaskComplete(
  ctaAction: string,
  ctx: { uploadedCategories: string[]; outstandingDocsClear: boolean }
): boolean {
  if (ctx.outstandingDocsClear) return true;
  const k = String(ctaAction ?? "");
  const cats = ctx.uploadedCategories.map((c) => String(c ?? "").toLowerCase());
  if (k.startsWith("upload:")) {
    const t = k.slice(7).toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!t) return false;
    return cats.some((c) => { const cc = c.replace(/[^a-z0-9]/g, ""); return !!cc && (cc.includes(t) || t.includes(cc)); });
  }
  // bare "upload" = Government ID
  return cats.some((c) => /gov|government|photo.?id|identification|\bid\b/.test(c));
}

// GET /api/applications/:id/task-status — read-only staff task completion status.
// Gated by the requireAuth + APPLICATION_READ capability set above. No writes.
router.get('/:id/task-status', safeHandler(async (req: any, res: any) => {
  // BF_SERVER_BLOCK_v782_TASK_STATUS — read-only staff view of whether the
  // applicant has finished the tasks we asked of them (Connect Bank/Flinks, CRA,
  // Net Worth, Advisors, Debt, collateral, Gov ID, document upload). The required
  // set is exactly the task-prompt messages already posted to the client; each is
  // checked against the same completion signals v778 uses (submitted form
  // responses + uploaded non-rejected documents + all required docs in).
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "invalid id" });

  const prompts = await pool.query(
    `SELECT DISTINCT cta_action, max(cta_label) AS cta_label
       FROM communications_messages
      WHERE application_id::text = ($1)::text
        AND (cta_action LIKE 'form:%' OR cta_action LIKE 'upload:%'
             OR cta_action IN ('networth','flinks','cra','debt','realestate','equipment','advisors','upload','upload_docs'))
      GROUP BY cta_action`, [id]).catch(() => ({ rows: [] as any[] }));
  const forms = await pool.query(
    `SELECT doc_type FROM application_form_responses WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`, [id]).catch(() => ({ rows: [] as any[] }));
  const docs = await pool.query(
    `SELECT DISTINCT lower(coalesce(category,'')) AS category FROM documents WHERE application_id::text = ($1)::text AND coalesce(status,'') <> 'rejected'`, [id]).catch(() => ({ rows: [] as any[] }));

  const formKey = (dt: any): string | null => {
    const x = String(dt ?? "").toLowerCase();
    if (/cra/.test(x)) return "cra";
    if (/net.?worth/.test(x)) return "networth";
    if (/advisor/.test(x)) return "advisors";
    if (/debt/.test(x)) return "debt";
    if (/equipment/.test(x)) return "equipment";
    if (/real.?estate/.test(x)) return "realestate";
    if (/flinks|bank/.test(x)) return "flinks";
    return null;
  };
  const completed = new Set<string>();
  for (const r of (forms.rows ?? [])) { const k = formKey((r as any).doc_type); if (k) completed.add(k); }
  const uploaded = new Set<string>((docs.rows ?? []).map((r: any) => String(r.category || "")).filter(Boolean));
  // BF_SERVER_BLOCK_v_TASK_DOCS_AUTHORITATIVE_v1 — document tasks are authoritative from
  // the client's live outstanding-docs signal (see helper above), so the staff checklist
  // matches the CMP. Forms stay form-response driven (added to `completed` above).
  let outstandingDocsClear = false;
  try {
    const outstanding = await computeOutstandingDocs(id);
    outstandingDocsClear = outstanding.stillNeeded.length === 0 && outstanding.rejected.length === 0;
  } catch { /* on error, treat as NOT clear so nothing is falsely marked done */ }
  if (isDocUploadTaskComplete("upload", { uploadedCategories: [...uploaded], outstandingDocsClear })) completed.add("upload");
  if (outstandingDocsClear) completed.add("upload_docs");

  const LABELS: Record<string, string> = {
    networth: "Personal Net Worth", flinks: "Connect Bank (View-Only)", cra: "CRA Authorization",
    debt: "Debt Stack", realestate: "Real Estate Collateral", equipment: "Equipment Collateral",
    advisors: "Professional Advisors", upload: "Upload Government ID", upload_docs: "Upload Documents",
  };
  const isDone = (cta: any): boolean => {
    let k = String(cta ?? ""); if (k.startsWith("form:")) k = k.slice(5);
    if (k.startsWith("upload:")) return isDocUploadTaskComplete(k, { uploadedCategories: [...uploaded], outstandingDocsClear });
    return completed.has(k);
  };
  // BF_SERVER_BLOCK_v_FORM_WAIVERS_v1 — a waived form (unchecked in Request Items)
  // must also drop off the client's task list so both tabs agree.
  const v_waivedFormsRes = await pool.query<{ document_type: string }>(
    `SELECT document_type FROM application_document_waivers
      WHERE application_id::text = ($1)::text AND lower(document_type) LIKE 'form:%'`, [id]
  ).catch(() => ({ rows: [] as Array<{ document_type: string }> }));
  const v_waivedForms = new Set(
    v_waivedFormsRes.rows.map((r: any) => String(r.document_type ?? "").trim().toLowerCase().slice(5)).filter(Boolean)
  );
  const tasks = (prompts.rows ?? []).map((m: any) => {
    let k = String(m.cta_action ?? ""); if (k.startsWith("form:")) k = k.slice(5);
    const label = (k.startsWith("upload:")) ? (m.cta_label || ("Re-upload " + k.slice(7))) : (m.cta_label || LABELS[k] || k);
    return { key: k, label, complete: isDone(m.cta_action) };
  }).filter((t: any) => !v_waivedForms.has(String(t.key).toLowerCase()))
    .sort((a: any, b: any) => Number(a.complete) - Number(b.complete));
  const total = tasks.length;
  const done = tasks.filter((t: any) => t.complete).length;
  return res.json({ applicationId: id, tasks, summary: { total, complete: done, outstanding: total - done, allComplete: total > 0 && done === total } });
}));

// BF_SERVER_BLOCK_v792_REQUEST_STEPS — staff-initiated "request additional steps".
// Posts the picked Stage-2 forms and/or a document-upload task to the client
// mini-portal as real task buttons (reusing the v711/v775 cta_action contract that
// v778 hides on completion and v782 reports), advances the card to "Additional
// Steps Required", and sends ONE SMS. Idempotent: forms already requested are
// skipped; a second doc request without a fresh button posts an informational note.
router.post('/:id/request-steps', requireCapability([CAPABILITIES.CRM_WRITE]), safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid id' });

  const FORM_LABELS: Record<string, string> = {
    networth: 'Personal Net Worth', flinks: 'Connect Bank (View-Only)', cra: 'CRA Authorization',
    debt: 'Debt Stack', realestate: 'Real Estate Collateral', equipment: 'Equipment Collateral',
    advisors: 'Professional Advisors', upload: 'Upload Government ID',
  };
  const b = req.body ?? {};
  const reqForms: string[] = Array.isArray(b.forms)
    ? b.forms.map((x: any) => String(x).trim().toLowerCase()).filter((x: string) => x in FORM_LABELS) : [];
  const reqDocs: string[] = Array.isArray(b.documents)
    ? b.documents.map((x: any) => String(x).trim()).filter(Boolean) : [];
  const uniqForms = Array.from(new Set(reqForms));
  const uniqDocs = Array.from(new Set(reqDocs));
  if (!uniqForms.length && !uniqDocs.length) {
    return res.status(400).json({ error: 'no_steps', message: 'Pick at least one form or document.' });
  }

  const appRow = await pool.query(`SELECT id FROM applications WHERE id::text = ($1)::text LIMIT 1`, [id]);
  if (!appRow.rows.length) return res.status(404).json({ error: 'not_found' });

  // Existing prompts → idempotency.
  const existing = await pool.query(
    `SELECT DISTINCT cta_action FROM communications_messages WHERE application_id::text = ($1)::text`, [id],
  ).catch(() => ({ rows: [] as any[] }));
  const existingActions: string[] = (existing.rows ?? []).map((r: any) => String(r.cta_action ?? ''));
  const existingCta = new Set<string>(existingActions.flatMap((cta: string) => {
    const normalized = cta.startsWith('form:') ? cta.slice(5) : cta;
    return normalized === cta ? [cta] : [cta, normalized];
  }));
  const hasUploadDocs = existingActions.some((cta: string) => cta === 'upload_docs' || cta.startsWith('upload:'));

  const contactSub = `(SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1)`;
  const siloSub = `COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF')`;

  const postedForms: string[] = [];
  for (const fid of uniqForms) {
    if (existingCta.has(fid)) continue;
    const label = FORM_LABELS[fid];
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
       VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, ${contactSub}, ${siloSub}, $2, 'Boreal Financial', $3, $4, now())`,
      [id, `Please complete the ${label} step to continue your application.`, label, fid],
    );
    postedForms.push(fid);
  }

  if (uniqDocs.length) {
    const list = uniqDocs.length === 1
      ? uniqDocs[0]
      : `${uniqDocs.slice(0, -1).join(', ')} and ${uniqDocs[uniqDocs.length - 1]}`;
    if (!hasUploadDocs) {
      await pool.query(
        `INSERT INTO communications_messages
           (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
         VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, ${contactSub}, ${siloSub}, $2, 'Boreal Financial', 'Upload documents', 'upload_docs', now())`,
        [id, `To continue your application, please upload your supporting documents: ${list}.`],
      );
    } else {
      await pool.query(
        `INSERT INTO communications_messages
           (id, type, direction, status, application_id, contact_id, silo, body, staff_name, created_at)
         VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1, ${contactSub}, ${siloSub}, $2, 'Boreal Financial', now())`,
        [id, `We've added more documents to your checklist: ${list}. Please upload them using the Upload documents button.`],
      );
    }
  }

  // Advance the card — but never resurrect a closed deal.
  await pool.query(
    `UPDATE applications SET pipeline_state = 'Additional Steps Required', updated_at = now()
      WHERE id::text = ($1)::text AND COALESCE(pipeline_state, '') NOT IN ('Accepted','Rejected','Archived')`,
    [id],
  ).catch(() => {});

  // ONE SMS to the client.
  let smsSent = false;
  try {
    const ph = await pool.query<{ phone: string | null }>(
      `SELECT c.phone FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = ($1)::text LIMIT 1`, [id],
    );
    const phone = ph.rows[0]?.phone ?? null;
    if (phone) {
      const base = (process.env.CLIENT_BASE_URL ?? 'https://client.boreal.financial').replace(/\/+$/, '');
      const url = `${base}/application/${id}`;
      const { sendSms } = await import('../notifications/sms.service.js');
      await sendSms({ to: String(phone), message: `Boreal Financial: we need a few more items to continue your application. Please log in to complete them: ${url}` }).catch(() => {});
      smsSent = true;
    }
  } catch { /* non-fatal */ }

  return res.json({
    ok: true,
    applicationId: id,
    posted: { forms: postedForms, formsSkipped: uniqForms.filter((f) => !postedForms.includes(f)), documents: uniqDocs },
    pipeline_state: 'Additional Steps Required',
    sms_sent: smsSent,
  });
}));

// BF_SERVER_BLOCK_v766_PHONE_DEBUG — read-only staff diagnostic. Shows what the
// CMP switcher's by-phone lookup matches for a given phone, plus the contact
// phone each application is actually linked to, so a grouping mismatch (two apps
// on different phones) is visible. Optional ?ids=id1,id2 inspects specific apps.
// Gated by the requireAuth + APPLICATION_READ capability set above. No writes.
router.get('/phone-debug', safeHandler(async (req: any, res: any) => {
  const phoneRaw = String(req.query?.phone ?? "").trim();
  const phone10 = phoneRaw.replace(/[^0-9]/g, "").slice(-10);
  const ids = String(req.query?.ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!phone10 && ids.length === 0) {
    return res.status(400).json({ error: "provide ?phone= or ?ids=id1,id2" });
  }

  const cols = `a.id, a.pipeline_state, a.product_category, a.requested_amount,
                a.name AS business_name, a.contact_id, c.phone AS contact_phone,
                right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) AS contact_phone_last10,
                a.updated_at`;

  let matched: any[] = [];
  if (phone10) {
    const r = await pool.query(
      `SELECT ${cols}
         FROM applications a
         JOIN contacts c ON c.id = a.contact_id
        WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
        ORDER BY a.updated_at DESC`,
      [phone10],
    );
    matched = r.rows;
  }

  let byIds: any[] = [];
  if (ids.length) {
    const r = await pool.query(
      `SELECT ${cols}
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = ANY($1::text[])`,
      [ids],
    );
    byIds = r.rows;
  }

  return res.json({
    phone10: phone10 || null,
    matched_count: matched.length,
    matched,
    by_ids: byIds,
    note: "matched = apps whose linked contact phone (last 10 digits) equals phone10. The switcher groups exactly these. If two apps you expect are not both here, compare their contact_phone_last10 via ?ids=.",
  });
}));

// GET /api/applications/:id — single application with documents
router.get('/:id', safeHandler(async (req: any, res: any) => {
  // BF_SERVER_BLOCK_v216_APPLICATION_DETAIL_BI_FIELDS_v1
  // Surface BI handoff columns (added in v213) so client surfaces
  // — notably Maya in the BF-client mini-portal — can read the
  // completion URL and tell the applicant where to finish PGI.
  // All three columns are nullable; an application that didn't
  // opt into PGI returns nulls for all three.
  const result = await pool.query(
    `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
            a.requested_amount, a.lender_id, a.lender_product_id,
            a.owner_user_id, a.source, a.created_at, a.updated_at,
            a.metadata, a.processing_stage, a.current_stage,
            a.silo, a.ocr_completed_at, a.banking_completed_at,
            a.bi_application_id, a.bi_public_id, a.bi_completion_url
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
  const { getSilo } = await import("../../middleware/silo.js");
  const callerSilo = getSilo(res) ?? null;
  const own = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [id],
  );
  if (!own.rows.length) return res.status(404).json({ error: 'not_found' });
  if (own.rows[0].silo && callerSilo && own.rows[0].silo !== callerSilo) {
    return res.status(403).json({ error: 'wrong_silo' });
  }
  const { rowCount } = await pool.query(`DELETE FROM applications WHERE id::text = ($1)::text`, [id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
}));

// v621: lender packages listing (E2E harness + portal "send to lender" view).
router.get("/:id/lender-packages", requireAuth, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: "invalid_id" });
  const { getSilo } = await import("../../middleware/silo.js");
  const callerSilo = getSilo(res) ?? null;
  const own = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [id],
  );
  if (!own.rows.length) return res.status(404).json({ error: "not_found" });
  if (own.rows[0].silo && callerSilo && own.rows[0].silo !== callerSilo) {
    return res.status(403).json({ error: "wrong_silo" });
  }
  const r = await pool.query(
    `SELECT
        ap.id,
        ap.application_id,
        ap.lender_id,
        ap.status,
        ap.delivered_to,
        ap.error,
        ap.bytes,
        ap.created_at,
        l.name AS lender_name,
        COALESCE(
          (SELECT json_agg(json_build_object(
              'id', d.id,
              'category', d.document_type,
              'filename', d.filename,
              'size', d.size,
              'ocr_status', d.ocr_status
            ) ORDER BY d.created_at)
             FROM documents d
            WHERE d.application_id = ap.application_id
              AND d.deleted_at IS NULL),
          '[]'::json
        ) AS included_documents
       FROM application_packages ap
       LEFT JOIN lenders l ON l.id = ap.lender_id
      WHERE ap.application_id::text = ($1)::text
      ORDER BY ap.created_at DESC`,
    [id],
  );
  res.json({ packages: r.rows ?? [] });
}));

router.get("/:id/contacts", requireAuth, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
    return res.status(400).json({ error: "invalid_id" });
  }
  const { getSilo } = await import("../../middleware/silo.js");
  const callerSilo = getSilo(res) ?? null;
  const ownership = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  if (!ownership.rows.length) return res.status(404).json({ error: "not_found" });
  if (ownership.rows[0].silo && callerSilo && ownership.rows[0].silo !== callerSilo) {
    return res.status(403).json({ error: "wrong_silo" });
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
// BF_SERVER_BLOCK_67_BANKING_DIAGNOSTICS_AND_RETRY_v1
// Admin-only force-retry. Resets next_attempt_at and attempt_count so the
// banking auto-worker picks the row up on the next tick. Worker handles
// the actual run; this just opens the gate.
router.post('/:id/banking-analysis/retry', requireAuth, requireAdmin, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.id || '').trim();
  if (!applicationId) return res.status(400).json({ error: 'application_id_required' });
  const r = await pool.query(
    `UPDATE banking_analyses
        SET status = 'pending',
            attempt_count = 0,
            next_attempt_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE application_id::text = ($1)::text
      RETURNING application_id`,
    [applicationId],
  );
  if (r.rowCount === 0) {
    // No prior banking_analyses row — insert one in 'pending' so the worker creates it on next tick.
    await pool.query(
      `INSERT INTO banking_analyses (application_id, status, attempt_count, max_attempts, next_attempt_at, updated_at)
       VALUES ($1, 'pending', 0, 3, NOW(), NOW())
       ON CONFLICT (application_id) DO NOTHING`,
      [applicationId],
    );
  }
  return res.status(202).json({ applicationId, queued: true });
}));

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
  const richRes = await pool.query<any>(`SELECT total_avg_monthly_deposits, average_daily_balance, negative_balance_days, total_deposits, total_withdrawals, average_monthly_nsfs, days_with_insufficient_funds, months_profitable_numerator, months_profitable_denominator, current_month_net_cash_flow, unusual_transactions, top_vendors, period_start, period_end, months_detected, accounts, status AS analysis_status, completed_at, last_error, attempt_count, max_attempts, next_attempt_at FROM banking_analyses WHERE application_id::text = ($1)::text`, [applicationId]);
  const monthlyRes = await pool.query<any>(`SELECT month_start::text AS month, total_deposits::text AS deposits, total_withdrawals::text AS withdrawals, net_cash_flow::text AS net, ending_balance::text AS ending_balance, nsf_count FROM banking_monthly_summaries WHERE application_id::text = ($1)::text ORDER BY month_start ASC`, [applicationId]);
  const rich = richRes.rows[0] ?? null;
  const monthly = monthlyRes.rows;
  const documentStatuses = Array.isArray(rich?.accounts)
    ? (rich.accounts.find((entry: any) => entry && Array.isArray(entry.documentStatuses))?.documentStatuses ?? [])
    : [];
  const bankCount = Number(counts.bank_total) || 0;
  const completedBankCount = Number(counts.bank_completed) || 0;
  const allDocsUnparsed =
    Array.isArray(documentStatuses) &&
    documentStatuses.length > 0 &&
    documentStatuses.every((doc: any) => String(doc?.detectedType ?? "").toUpperCase() === "OTHER" || !!doc?.error);

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
    documents: documentStatuses,
    ocrParseWarning: allDocsUnparsed
      ? "OCR could not parse these documents as bank statements. Verify the uploaded files are bank-statement PDFs and not photos, screenshots, or summary letters."
      : null,
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
    // BF_SERVER_BLOCK_67_BANKING_DIAGNOSTICS_AND_RETRY_v1
    lastError: rich?.last_error ?? null,
    attemptCount: rich?.attempt_count ?? 0,
    maxAttempts: rich?.max_attempts ?? 3,
    nextAttemptAt: rich?.next_attempt_at ?? null,
    status: rich?.analysis_status ?? (bankCount === 0
      ? 'no_bank_statements'
      : completedBankCount < bankCount
        ? 'analysis_in_progress'
        : 'analysis_complete'),
  });
}));

// GET /api/applications/:id/details — flat shape for portal drawer
// BF_SERVER_BLOCK_v_SIGNING_INDICATOR_v1 — derive the staff-facing signing state
// for the application header chip. Mirrors the CMP's signing-session readiness:
//   signed       — signnow_app_signed_at is set
//   started      — a SignNow group has been minted (metadata.signnow_embedded.group_id)
//   ready        — a lender is finalized (the CMP would show "Sign Documents"), no group yet
//   not_started  — no lender finalized
export function deriveSigningStatus(input: { signedAt: unknown; groupId: unknown; finalizedLenders: number }): 'signed' | 'started' | 'ready' | 'not_started' {
  if (input.signedAt) return 'signed';
  if (input.groupId) return 'started';
  if (input.finalizedLenders > 0) return 'ready';
  return 'not_started';
}

router.get('/:id/details', safeHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const result = await pool.query(
    `SELECT a.id, a.name, a.product_type, a.pipeline_state, a.status,
            a.requested_amount, a.metadata, a.processing_stage,
            a.current_stage, a.silo, a.created_at, a.updated_at,
            a.signnow_app_signed_at,
            (SELECT count(*) FROM application_lender_selections s
              WHERE s.application_id::text = a.id::text AND s.finalized_at IS NOT NULL) AS finalized_lenders
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

  // BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1 — (B)
  // Readiness drafts (website /credit-readiness submissions, before the
  // user has filled the wizard) carry their data under metadata.readiness
  // — a single object set by publicApplication.ts's phone-claim path
  // (v129a) holding {fullName, email, phone, industry, businessLocation,
  // fundingType, requestedAmount, purposeOfFunds, salesHistoryYears,
  // annualRevenueRange, avgMonthlyRevenueRange, accountsReceivableRange,
  // fixedAssetsValueRange}. Use it as a last-resort fallback so the
  // staff drawer's Application tab surfaces these fields before the
  // wizard submit-time PATCH writes the canonical kyc / business /
  // applicant slots. Existing sources still win — readiness is purely
  // additive at the tail of each fallback chain.
  const readinessSrc =
    (md?.readiness && typeof md.readiness === 'object')
      ? md.readiness as Record<string, any>
      : null;

  // BF_SERVER_BLOCK_v_SIGNING_INDICATOR_v1 — staff signing-state indicator source.
  const snEmbed = (md?.signnow_embedded && typeof md.signnow_embedded === 'object') ? md.signnow_embedded as Record<string, any> : null;
  const signingStatus = deriveSigningStatus({
    signedAt: app.signnow_app_signed_at ?? null,
    groupId: snEmbed?.group_id ?? null,
    finalizedLenders: Number(app.finalized_lenders ?? 0),
  });

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
    kyc: md?.borrower ?? md?.kyc_responses ?? md?.kyc ?? fd?.kyc ?? fd?.financialProfile ?? readinessSrc ?? null,
    applicantDetails: md?.borrower ?? md?.applicant ?? fd?.applicant ?? readinessSrc ?? null,
    applicantInfo: md?.borrower ?? md?.applicant ?? fd?.applicant ?? readinessSrc ?? null,
    businessDetails: md?.company ?? md?.business ?? fd?.business ?? readinessSrc ?? null,
    business: md?.company ?? md?.business ?? fd?.business ?? readinessSrc ?? null,
    owners: Array.isArray(md?.owners)
      ? md.owners
      : (md?.partner ? [md.partner]
         : md?.applicant?.partner ? [md.applicant.partner]
         : fd?.applicant?.partner ? [fd.applicant.partner]
         : []),
    financialProfile: md?.financials ?? md?.kyc ?? fd?.kyc ?? fd?.financialProfile ?? readinessSrc ?? null,
    fundingRequest: {
      amount: app.requested_amount,
      productCategory: md?.application?.productCategory ?? md?.product_category ?? fd?.productCategory ?? null,
    },
    productCategory: md?.application?.productCategory ?? md?.product_category ?? fd?.productCategory ?? null,
    documents: Array.isArray(md?.documents) ? md.documents : null,
    signing: { status: signingStatus, signedAt: app.signnow_app_signed_at ?? null },
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

      // BF_SERVER_BLOCK_v301_APPLICATION_AUDIT_TIMELINE_FIX_v1
      // The drawer Audit tab consumes this endpoint via fetchApplicationAudit
      // and renders { id, type, createdAt, actor?, detail? }. The old query
      // selected from a non-existent table `application_audit_events` and
      // swallowed the resulting "relation does not exist" with .catch(() =>
      // ({rows: []})), so the tab silently returned [] for every application
      // even though all application-scoped events are written to
      // public.audit_events by recordAuditEvent() with target_type='application'
      // and target_id=<applicationId>. Switch to the real table, use the
      // canonical actor_user_id / metadata columns, and coalesce the three
      // historical "what happened" columns (event_type, event_action, action)
      // so events written by all generations of recordAuditEvent are surfaced.
      // Keep a defensive .catch so future schema drift degrades to [] rather
      // than 500, but log it instead of swallowing silently.
      const result = await pool.query(
        `SELECT id::text AS id,
                coalesce(event_type, event_action, action, 'event') AS type,
                created_at AS "createdAt",
                actor_user_id::text AS actor,
                metadata AS detail
           FROM audit_events
          WHERE target_type = 'application' AND target_id = $1
          ORDER BY created_at DESC
          LIMIT 200`,
        [id]
      ).catch((err: any) => {
        // eslint-disable-next-line no-console
        console.warn('applications.audit.query_failed', {
          applicationId: id,
          message: err?.message,
          code: err?.code,
        });
        return { rows: [] as any[] };
      });

  res.json({ status: 'ok', data: result.rows });
}));

// BF_SERVER_BLOCK_v321_APPLICATION_OFFERS_LIST_v1
// Pre-fix this endpoint did not exist. BF-portal LendersTab.tsx:119 calls
//   GET /api/applications/:id/offers?status=pending_acceptance
// to populate the "Pending Acceptance" UI section above the lender match
// table. With no handler mounted, every call 404'd, the portal's
// .catch(() => []) silently swallowed it, and staff never saw any offers
// awaiting their "Confirm acceptance" click. Combined with the v313 schema
// bug on the confirm-acceptance endpoint, the entire applicant-clicks-Accept
// → staff-confirms flow was broken end-to-end.
// Shape: portal expects { id, lenderName } per row (or an array directly).
// Returns an array so the existing destructure `Array.isArray(offers) ?
// offers : offers?.items ?? []` resolves cleanly. is_archived filter
// matches the other /offers endpoints' convention. Silo guard via JOIN
// through applications (offers.silo doesn't exist).
router.get('/:id/offers', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);

  const appRow = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [appId]
  );
  if (!appRow.rows[0]) throw new AppError('not_found', 'Application not found.', 404);
  const callerSilo = getSilo(res);
  const appSilo = appRow.rows[0].silo;
  if (appSilo && callerSilo && appSilo !== callerSilo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  const statusFilter = typeof req.query?.status === 'string' ? req.query.status.trim() : '';
  // Whitelist statuses to avoid surprise filter values; matches the relaxed
  // CHECK constraint from migrations/2026_05_14_offers_lifecycle_schema_v307.sql.
  const ALLOWED_STATUSES = new Set([
    'pending', 'pending_acceptance', 'accepted', 'declined', 'rejected',
    'changes_requested', 'expired', 'created', 'sent',
  ]);
  const params: unknown[] = [appId];
  let where = `application_id::text = ($1)::text AND coalesce(is_archived, false) = false`;
  if (statusFilter && ALLOWED_STATUSES.has(statusFilter)) {
    params.push(statusFilter);
    where += ` AND status = $${params.length}`;
  }

  const result = await pool.query(
    `SELECT id::text AS id,
            lender_name AS "lenderName",
            amount::text AS amount,
            rate_factor AS "rateFactor",
            term,
            payment_frequency AS "paymentFrequency",
            expiry_date AS "expiryDate",
            status,
            recommended,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
       FROM offers
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT 100`,
    params
  ).catch((err: any) => {
    // eslint-disable-next-line no-console
    console.warn('applications.offers.query_failed', {
      applicationId: appId, message: err?.message, code: err?.code,
    });
    return { rows: [] as any[] };
  });

  res.status(200).json(result.rows);
}));

// BF_APP_LENDERS_ENDPOINT_v42 — Block 42-A
// Real lender-matches endpoint. Replaces the placeholder consumed by the staff
// LendersTab. Reads application metadata, runs the match engine, and joins
// existing lender_submissions to enrich each match with submission status.
// BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
router.get('/:id/lenders', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  const appRes = await pool.query(
    `select id, silo from applications where id::text = ($1)::text limit 1`,
    [appId]
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const matches = await readCachedMatchesArray(appId);
  res.status(200).json(matches);
}));

router.get('/:id/lenders/envelope', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  const appRes = await pool.query(
    `select id, silo from applications where id::text = ($1)::text limit 1`,
    [appId]
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  const envelope = await readLenderMatchEnvelope(appId);
  res.status(200).json(envelope);
}));

router.post('/:id/lenders/recalculate', safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  if (!appId) throw new AppError('validation_error', 'Application id required.', 400);
  const appRes = await pool.query(
    `select id, silo from applications where id::text = ($1)::text limit 1`,
    [appId]
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }
  await computeAndCacheLenderMatches(appId);
  const envelope = await readLenderMatchEnvelope(appId);
  res.status(200).json(envelope);
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
  // v624: applicant's Step 2 product category. Used to filter lender_products
  // so Step 5 only unions docs from products in the chosen category.
  // Reads from metadata.product_category (canonical) OR
  // metadata.selected_product.* (legacy wizard path). Normalized lowercase.
  const category = (() => {
    const raw = String(
      meta.product_category
      ?? meta.selected_product_type
      ?? meta.selected_product?.capitalCategory
      ?? (meta.selected_product?.wantsEquipment ? 'EQUIPMENT' : null)
      ?? meta.selected_product?.category
      ?? ''
    ).trim().toLowerCase();
    return raw || null;
  })();
  const colsRes = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'lender_products'`
  ).catch(() => ({ rows: [] as Array<{ column_name: string }> }));
  const cols = new Set(colsRes.rows.map((r: { column_name: string }) => r.column_name));
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
    // v624: restrict to lender_products in the applicant's chosen category.
    // Comparison is case-insensitive trim on both sides. NULL category on
    // a product row is treated as a wildcard (legacy un-categorized rows).
    if (category && cols.has('category')) {
      params.push(category);
      where.push(`(category IS NULL OR LOWER(TRIM(category)) = $${params.length})`);
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
      // v624: Step 5 shows stage-1 docs only. Items missing a stage field
      // default to stage 1 (back-compat with rows created before the
      // two-stage upgrade).
      const stage = ((): 1 | 2 => {
        const raw = (item as any)?.stage;
        if (raw === 2 || raw === '2') return 2;
        return 1;
      })();
      if (stage !== 1) continue;
      const required = Boolean(item?.required);
      const existing = categoryMap.get(key);
      categoryMap.set(key, { key, label: existing?.label ?? key, required: Boolean(existing?.required || required) });
    }
  }
  type FileRow = { id: string; filename: string | null; size_bytes: number | null; created_at: Date; status: string | null; category: string | null; ocr_status: string | null; ocr_text: string | null; ocr_text_truncated: boolean | null; ocr_tables_count: number | null; ocr_extracted_at: Date | null; };
  let fileRows: FileRow[] = [];
  try {
    // BF_SERVER_BLOCK_v643_OCR_QUERY_FIX_v1 — drop the broken OCR join.
    // Migration 018 renamed the old ocr_results (which had extracted_text)
    // to ocr_document_results and replaced the name with a per-FIELD table
    // (field_key/value/confidence). The join referenced columns that exist
    // on neither shape. Banking / Financials tabs were 500-ing. Returning
    // null for ocr_* fields is acceptable; Todd confirmed OCR is no longer
    // required for these documents.
    const r = await pool.query<FileRow>(
      `SELECT
          d.id::text AS id,
          COALESCE(d.filename, d.title) AS filename,
          d.size_bytes AS size_bytes,
          d.created_at AS created_at,
          d.status AS status,
          COALESCE(d.category, d.document_type) AS category,
          d.ocr_status AS ocr_status,
          NULL::text  AS ocr_text,
          FALSE       AS ocr_text_truncated,
          0           AS ocr_tables_count,
          NULL::timestamp AS ocr_extracted_at
       FROM documents d
       WHERE d.application_id::text = ($1)::text
       ORDER BY d.created_at ASC`,
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
        `SELECT
            d.id::text AS id,
            COALESCE(d.filename, d.title) AS filename,
            d.size_bytes AS size_bytes,
            d.created_at AS created_at,
            d.status AS status,
            COALESCE(d.category, d.document_type) AS category,
            d.ocr_status AS ocr_status,
            NULL::text  AS ocr_text,
            FALSE       AS ocr_text_truncated,
            0           AS ocr_tables_count,
            NULL::timestamp AS ocr_extracted_at
         FROM documents d
         WHERE d.application_id::text = ($1)::text
         ORDER BY d.created_at ASC`,
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
  const categories: Array<{ key: string; label: string; required: boolean; files: Array<{ id: string; filename: string; size: number | null; uploadedAt: string | null; status: string; url: string | null; ocr_status: string | null; ocr_text: string | null; ocr_text_truncated: boolean; ocr_tables_count: number; ocr_extracted_at: string | null; }>; }> = [];
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
    ocr_status: f.ocr_status ?? null,
    ocr_text: f.ocr_text ?? null,
    ocr_text_truncated: Boolean(f.ocr_text_truncated),
    ocr_tables_count: Number(f.ocr_tables_count ?? 0),
    ocr_extracted_at: f.ocr_extracted_at ? new Date(f.ocr_extracted_at as any).toISOString() : null,
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
// BF_SERVER_BLOCK_v328_LENDERS_FILES_HONEST_501_v1
// Pre-fix this endpoint was a half-implementation that silently failed
// in production. Failure mode chain:
//   1. No multer middleware was applied, so req.file was always undefined
//      and req.body (from a multipart/form-data POST) was empty.
//   2. The handler defaulted filename to the literal string "lender-upload"
//      and sizeBytes to null.
//   3. It INSERTed a documents row with category='lender:<lenderId>',
//      status='uploaded', and the bogus filename. No blob storage write
//      ever occurred — the actual file bytes were dropped on the floor.
//   4. The INSERT error path used .catch(() => {}) so a column-drift or
//      DB error would silently swallow.
//   5. No document_versions row was inserted, so the standard OCR /
//      banking analysis workers (which key off document_versions, per
//      documents.ts:88-100) never picked it up.
//   6. The handler returned { ok: true, documentId } regardless, so the
//      BF-portal LendersTab.tsx:194 caller's success path ran and refetched
//      the envelope. Staff thought the file uploaded; the lender dropdown
//      eventually showed "lender-upload" entries pointing at no actual file.
// Returning 501 with a clear error message instead of the silent-success
// stub:
//   - The portal's catch path on LendersTab.tsx:202 now logs an honest
//     "upload_term_sheet_failed" so the operator can see the failure.
//   - No more orphan documents rows accumulate in production.
//   - A future implementer has a clear contract to satisfy: add multer,
//     write to blob storage via getStorage().put, INSERT document_versions
//     keyed to the new documents row, and trigger the OCR worker. The
//     canonical reference is the /api/documents/upload handler in
//     src/routes/documents.ts which does this end-to-end.
// Silo guard preserved above the early return so it still runs for the
// 404 case (don't reveal cross-silo application existence even on a
// 501 surface).
// Per-lender term-sheet upload. A term sheet IS that lender's offer, so this
// stores the PDF, creates an offer row tied to the lender (archiving only THIS
// lender's prior active offer so competing offers from other lenders survive),
// advances Off to Lender -> Offer, and texts the client a review link.
router.post('/:id/lenders/:lenderId/files', lenderTermSheetUpload.single('file'), safeHandler(async (req: any, res: any) => {
  const appId = String(req.params.id ?? '').trim();
  const lenderId = String(req.params.lenderId ?? '').trim();
  if (!appId || !lenderId) throw new AppError('validation_error', 'application id and lender id required.', 400);
  const file = req.file as Express.Multer.File | undefined;
  if (!file) throw new AppError('validation_error', 'Term sheet file is required.', 400);

  const appRes = await pool.query<{ silo: string | null; pipeline_state: string | null }>(
    `SELECT silo, pipeline_state FROM applications WHERE id::text = ($1)::text LIMIT 1`, [appId],
  );
  const app = appRes.rows[0];
  if (!app) throw new AppError('not_found', 'Application not found.', 404);
  const silo = getSilo(res);
  if (app.silo && silo && app.silo !== silo) {
    throw new AppError('not_found', 'Application not found.', 404);
  }

  // The Lenders tab sends the lender_product_id as :lenderId (match.id = product
  // id). Resolve it to the owning lender; fall back to a direct lender id.
  const prodRes = await pool.query<{ lender_id: string | null; name: string | null }>(
    `SELECT l.id::text AS lender_id, l.name
       FROM lender_products lp JOIN lenders l ON l.id = lp.lender_id
      WHERE lp.id::text = ($1)::text LIMIT 1`,
    [lenderId],
  );
  let resolvedLenderId = prodRes.rows[0]?.lender_id ?? null;
  let lenderName = (prodRes.rows[0]?.name ?? '').trim();
  if (!resolvedLenderId) {
    const direct = await pool.query<{ id: string; name: string | null }>(
      `SELECT id::text AS id, name FROM lenders WHERE id::text = ($1)::text LIMIT 1`,
      [lenderId],
    );
    resolvedLenderId = direct.rows[0]?.id ?? null;
    lenderName = (direct.rows[0]?.name ?? '').trim();
  }
  if (!resolvedLenderId || !lenderName) throw new AppError('not_found', 'Lender not found.', 404);

  const b = req.body ?? {};
  const num = (v: any) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const amount = num(b.amount);
  const rateFactor = str(b.rate_factor);
  const term = str(b.term);
  const paymentFrequency = str(b.payment_frequency);
  const expiryDate = str(b.expiry_date);
  const notes = str(b.notes);

  const put = await getStorage().put({
    buffer: file.buffer,
    filename: file.originalname,
    contentType: file.mimetype,
    pathPrefix: `applications/${appId}/term-sheets`,
  });

  // Archive only this lender's prior active offer (competing offers preserved).
  await pool.query(
    `UPDATE offers SET is_archived = TRUE, archived_at = now(), updated_at = now()
      WHERE application_id::text = ($1)::text AND lender_id::text = ($2)::text AND is_archived = FALSE`,
    [appId, resolvedLenderId],
  ).catch(() => {});

  const offerId = randomUUID();
  await pool.query(
    `INSERT INTO offers (
       id, application_id, lender_id, lender_name, amount, rate_factor, term, payment_frequency,
       expiry_date, document_url, notes, status, recommended,
       term_sheet_blob_name, term_sheet_filename, term_sheet_size_bytes, term_sheet_uploaded_at,
       is_archived, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', false,
             $12, $13, $14, now(), false, now(), now())`,
    [offerId, appId, resolvedLenderId, lenderName, amount, rateFactor, term, paymentFrequency,
     expiryDate, put.url, notes, put.blobName, file.originalname, put.sizeBytes],
  );

  let stage = app.pipeline_state ?? null;
  // A term sheet IS the lender's offer, so issuing one moves the app to the
  // Offer stage regardless of where it was — staff may upload an offer before
  // the app was formally marked Off to Lender. Never move terminal stages.
  if (stage !== 'Offer' && stage !== 'Accepted' && stage !== 'Rejected') {
    await pool.query(
      `UPDATE applications SET pipeline_state = 'Offer', updated_at = now() WHERE id::text = ($1)::text`,
      [appId],
    ).catch(() => {});
    stage = 'Offer';
  }

  try {
    const phoneRes = await pool.query<{ phone: string | null }>(
      `SELECT c.phone AS phone FROM applications a LEFT JOIN contacts c ON c.id::text = a.contact_id::text WHERE a.id::text = ($1)::text LIMIT 1`,
      [appId],
    );
    const phone = phoneRes.rows[0]?.phone ?? null;
    if (phone) {
      const portalBase = process.env.CLIENT_PORTAL_URL || 'https://client.boreal.financial';
      await sendSMS(phone, `Your term sheet from ${lenderName} is ready to review: ${portalBase}/application/${appId}`);
    }
  } catch (err) {
    console.warn('[lender-term-sheet] SMS notification failed', { appId, err: String(err) });
  }

  return res.status(201).json({ ok: true, offer_id: offerId, lender_id: resolvedLenderId, blob_name: put.blobName, stage });
}));

export default router;
