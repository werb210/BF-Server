import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { sendgridConfigured, sendOne, mergeFields } from "../services/sendgridService.js";
import { suggestionsConfigured, buildSuggestions, applySuggestion } from "../services/googleAdsSuggestions.js";
import { previewIcp, buildHashedList } from "../services/googleAdsCustomerMatch.js";
import { ga4Configured, runGa4Report } from "../services/ga4Service.js";
import { clarityConfigured, runClarityReport } from "../services/clarityService.js";
import { conversionsConfigured, findPendingConversions, uploadFundedConversions } from "../services/googleAdsConversions.js";
import { googleAdsConfigured, runGoogleAdsReport } from "../services/googleAdsService.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.MARKETING_VIEW]));

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, { status: "ok" });
}));

router.get("/campaigns", safeHandler((req: any, res: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  respondOk(
    res,
    {
      campaigns: [],
      total: 0,
    },
    {
      page,
      pageSize,
    }
  );
}));

// BF_SERVER_MARKETING_FUNNEL_v1 — internal application funnel from our own DB (no external deps):
// how many applications reached each wizard step, and how many submitted, with drop-off per step.
router.get("/funnel", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query<{
    started: number; step2: number; step3: number; step4: number;
    step5: number; step6: number; submitted: number;
  }>(
    `SELECT
       count(*)::int AS started,
       count(*) FILTER (WHERE current_step >= 2)::int AS step2,
       count(*) FILTER (WHERE current_step >= 3)::int AS step3,
       count(*) FILTER (WHERE current_step >= 4)::int AS step4,
       count(*) FILTER (WHERE current_step >= 5)::int AS step5,
       count(*) FILTER (WHERE current_step >= 6)::int AS step6,
       count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted
     FROM applications
     WHERE silo = $1
       AND created_at >= now() - ($2 || ' days')::interval`,
    [silo, String(days)],
  );
  const r = rows[0] ?? { started: 0, step2: 0, step3: 0, step4: 0, step5: 0, step6: 0, submitted: 0 };
  const raw = [
    { key: "step1", label: "Step 1 \u00b7 Financial profile", count: Number(r.started) },
    { key: "step2", label: "Step 2 \u00b7 Product", count: Number(r.step2) },
    { key: "step3", label: "Step 3 \u00b7 Business", count: Number(r.step3) },
    { key: "step4", label: "Step 4 \u00b7 Applicant", count: Number(r.step4) },
    { key: "step5", label: "Step 5 \u00b7 Documents", count: Number(r.step5) },
    { key: "step6", label: "Step 6 \u00b7 Review", count: Number(r.step6) },
    { key: "submitted", label: "Submitted", count: Number(r.submitted) },
  ];
  const top = raw[0]?.count ?? 0;
  let prev = top;
  const steps = raw.map((sStep) => {
    const pctOfStart = top ? Math.round((sStep.count / top) * 1000) / 10 : 0;
    const dropFromPrev = prev ? Math.round((1 - sStep.count / prev) * 1000) / 10 : 0;
    prev = sStep.count;
    return { ...sStep, pctOfStart, dropFromPrev };
  });
  respondOk(res, { days, steps });
}));

// BF_SERVER_MARKETING_SOURCES_v1 - conversion by marketing source. Joins the
// internal funnel to apply-start attribution (utm_source, else referrer host,
// else 'direct'): how many applications each source STARTED vs SUBMITTED, and the
// conversion rate. Silo-aware.
router.get("/sources", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query<{ source: string; started: number; submitted: number }>(
    `SELECT
       COALESCE(
         NULLIF(metadata->'attribution'->>'utm_source', ''),
         NULLIF(regexp_replace(COALESCE(metadata->'attribution'->>'referrer',''), '^https?://([^/]+).*$', '\\1'), ''),
         'direct'
       ) AS source,
       count(*)::int AS started,
       count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted
     FROM applications
     WHERE silo = $1
       AND created_at >= now() - ($2 || ' days')::interval
     GROUP BY 1
     ORDER BY started DESC
     LIMIT 25`,
    [silo, String(days)],
  );
  const sources = rows.map((r) => {
    const started = Number(r.started), submitted = Number(r.submitted);
    return { source: r.source, started, submitted, conversion: started ? Math.round((submitted / started) * 1000) / 10 : 0 };
  });
  respondOk(res, { days, sources });
}));

// BF_SERVER_MARKETING_GA4_v1 — GA4 traffic/sources/devices via the Analytics Data API.
router.get("/ga4", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  if (!ga4Configured()) { respondOk(res, { configured: false }); return; }
  const report = await runGa4Report(days);
  respondOk(res, report ?? { configured: false });
}));

// BF_SERVER_MARKETING_GOOGLE_ADS_v1 - Google Ads spend/performance (read).
router.get("/google-ads", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  if (!googleAdsConfigured()) { respondOk(res, { configured: false }); return; }
  const report = await runGoogleAdsReport(days);
  respondOk(res, report ?? { configured: false });
}));

// BF_SERVER_MARKETING_CLARITY_v1 — Microsoft Clarity behavioral analytics (Data Export API).
// BF_SERVER_MARKETING_ADS_CONVERSIONS_v1 - closed-loop funded-deal conversions.
router.get("/google-ads/conversions/pending", safeHandler(async (_req: any, res: any) => {
  if (!conversionsConfigured()) { respondOk(res, { configured: false, pending: [] }); return; }
  const pending = await findPendingConversions();
  respondOk(res, { configured: true, count: pending.length, pending });
}));
router.post("/google-ads/conversions/upload", safeHandler(async (_req: any, res: any) => {
  const result = await uploadFundedConversions();
  respondOk(res, result);
}));

// BF_SERVER_MARKETING_ICP_PRODUCTS_v1 - product categories present on funded apps.
router.get("/google-ads/icp/products", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const { rows } = await pool.query<{ product_category: string }>(
    `SELECT DISTINCT product_category FROM applications
      WHERE silo = $1 AND pipeline_state = ANY(ARRAY['Accepted','Funded'])
        AND COALESCE(product_category,'') <> ''
      ORDER BY product_category`,
    [silo],
  );
  respondOk(res, { products: rows.map((r) => r.product_category) });
}));

// BF_SERVER_MARKETING_ICP_v1 - ideal-client engine (Customer Match seed + exclusion).
router.get("/google-ads/icp/preview", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const filters = { productCategory: req.query.productCategory ? String(req.query.productCategory) : undefined, minAmount: req.query.minAmount ? Number(req.query.minAmount) : undefined, maxAmount: req.query.maxAmount ? Number(req.query.maxAmount) : undefined };
  respondOk(res, await previewIcp(silo, filters));
}));
router.post("/google-ads/icp/export", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const type = b.type === "exclusion" ? "exclusion" : "seed";
  const filters = { productCategory: b.productCategory || undefined, minAmount: typeof b.minAmount === "number" ? b.minAmount : undefined, maxAmount: typeof b.maxAmount === "number" ? b.maxAmount : undefined };
  respondOk(res, await buildHashedList(silo, filters, type));
}));

// BF_SERVER_MARKETING_ADS_SUGGESTIONS_v1 - Maya campaign recommendations (human-approved).
router.get("/google-ads/suggestions", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  if (!suggestionsConfigured()) { respondOk(res, { configured: false, suggestions: [] }); return; }
  respondOk(res, await buildSuggestions(days));
}));
router.post("/google-ads/suggestions/apply", safeHandler(async (req: any, res: any) => {
  const action = req.body && req.body.action;
  if (!action || typeof action.type !== "string") { respondOk(res, { ok: false, error: "missing action" }); return; }
  respondOk(res, await applySuggestion(action));
}));

// BF_SERVER_MARKETING_EMAIL_v1 - SendGrid bulk marketing email (BF silo).
router.get("/email/segments", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const tags = await pool.query(
    `SELECT tag, count(*)::int AS n FROM (
       SELECT unnest(tags) AS tag FROM contacts
        WHERE silo = $1 AND COALESCE(email,'') <> '' AND COALESCE(marketing_opt_out,false) = false
     ) t GROUP BY tag ORDER BY n DESC`,
    [silo],
  );
  const total = await pool.query(
    `SELECT count(*)::int AS n FROM contacts WHERE silo = $1 AND COALESCE(email,'') <> '' AND COALESCE(marketing_opt_out,false) = false`,
    [silo],
  );
  respondOk(res, { configured: sendgridConfigured(), all: total.rows[0]?.n ?? 0, segments: tags.rows });
}));

router.post("/email/send", safeHandler(async (req: any, res: any) => {
  if (!sendgridConfigured()) { respondOk(res, { configured: false }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const subject = String(b.subject || "").trim();
  const html = String(b.html || "").trim();
  if (!subject || !html) { respondOk(res, { error: "subject and html required" }); return; }
  if (b.test && typeof b.test === "string") {
    const r = await sendOne({ to: b.test, subject: mergeFields(subject, { first_name: "there", name: "there", email: b.test, company: "" }), html: mergeFields(html, { first_name: "there", name: "there", email: b.test, company: "" }) });
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  const recips = await pool.query<{ id: string; email: string; name: string | null; company: string | null }>(
    `SELECT c.id, c.email, c.name, co.name AS company
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
      WHERE c.silo = $1 AND COALESCE(c.email,'') <> '' AND COALESCE(c.marketing_opt_out,false) = false
        AND ($2::text IS NULL OR $2 = ANY(c.tags))
      LIMIT 500`,
    [silo, tag],
  );
  let sent = 0, failed = 0;
  for (const c of recips.rows) {
    const first = (c.name || "").trim().split(/\s+/)[0] || "there";
    const vars = { first_name: first, name: c.name || "there", email: c.email, company: c.company || "" };
    try {
      const r = await sendOne({ to: c.email, subject: mergeFields(subject, vars), html: mergeFields(html, vars), contactId: c.id });
      if (r.ok) {
        sent++;
        await pool.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1,$2,$3)`, [c.id, "email_marketing_sent", JSON.stringify({ subject, tag })]);
      } else { failed++; }
    } catch { failed++; }
  }
  respondOk(res, { configured: true, recipients: recips.rows.length, sent, failed, capped: recips.rows.length >= 500 });
}));

router.get("/clarity", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 3, 1), 3);
  if (!clarityConfigured()) { respondOk(res, { configured: false }); return; }
  const report = await runClarityReport(days);
  respondOk(res, report ?? { configured: false });
}));

export default router;
