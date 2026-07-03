import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { createLandingPage, createLandingPageFromHtml, withViewInBrowser } from "../services/landingPage.service.js"; // BF_SERVER_BLOCK_v780_PUBLIC_LANDING
import { sendgridConfigured, sendOne, mergeFields } from "../services/sendgridService.js";
import { smsMarketingConfigured, sendMarketingSms } from "../services/marketingSms.js";
import { countEmailRecipients, runEmailSend, countSmsRecipients, runSmsSend } from "../services/marketingSendRunner.js"; // BF_SERVER_SEND_QUEUE_v1 BF_SERVER_SEND_QUEUE_SMS_v1
import { enrollSequence } from "../services/sequenceEngine.js"; // BF_SERVER_BLOCK_v785_SEQUENCES
import { suggestionsConfigured, buildSuggestions, applySuggestion } from "../services/googleAdsSuggestions.js";
import { linkedInSuggestionsConfigured, buildLinkedInSuggestions, applyLinkedInSuggestion } from "../services/linkedInAdsSuggestions.js"; // BF_SERVER_LINKEDIN_SUGGESTIONS_v1
import { previewIcp, buildHashedList, buildLinkedInAudienceCsv } from "../services/googleAdsCustomerMatch.js";
import { ga4Configured, runGa4Report } from "../services/ga4Service.js";
import { clarityConfigured, runClarityReport } from "../services/clarityService.js";
import { conversionsConfigured, findPendingConversions, uploadFundedConversions } from "../services/googleAdsConversions.js";
import { linkedInConversionsConfigured, findPendingLinkedInConversions, uploadFundedLinkedInConversions } from "../services/linkedInAdsConversions.js"; // BF_SERVER_LINKEDIN_CONVERSIONS_v1
import { googleAdsConfigured, runGoogleAdsReport } from "../services/googleAdsService.js";
import { linkedInAdsConfigured, runLinkedInAdsReport } from "../services/linkedInAdsService.js"; // BF_SERVER_LINKEDIN_ADS_v1
// BF_EMAIL_TEMPLATE_IMPORTS_v1
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";


const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.MARKETING_VIEW]));

// BF_SERVER_BLOCK_v780_PUBLIC_LANDING — render+store a landing page from
// branded-email fields; returns the public boreal.finance URL.
router.post("/landing", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body ?? {};
  const fields = {
    headline: String(b.headline ?? ""), heroUrl: String(b.heroUrl ?? ""),
    heroLink: String(b.heroLink ?? ""), body: String(b.body ?? ""),
    ctaLabel: String(b.ctaLabel ?? ""), ctaUrl: String(b.ctaUrl ?? ""),
    image2Url: String(b.image2Url ?? ""), image2Link: String(b.image2Link ?? ""),
  };
  const out = await createLandingPage({ fields, silo, title: b.title ?? b.headline ?? null, createdBy: req.user?.userId ?? null });
  respondOk(res, out);
}));

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

// BF_SERVER_MARKETING_FUNNEL_v1 - internal application funnel from our own DB (no external deps):
// how many applications reached each wizard step, and how many submitted, with drop-off per step.
router.get("/funnel", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query<{
    started: number; step2: number; step3: number; step4: number;
    step5: number; step6: number; submitted: number;
  }>(
    // BF_SERVER_BLOCK_v772_FUNNEL_METADATA_STEP: the wizard persists progress
    // into metadata.currentStep, not the current_step column (which the
    // save/resume path defaults to 1). Read the real source, and credit
    // submitted apps with the full path since submission implies all steps.
    `WITH a AS (
       SELECT COALESCE(
                NULLIF(metadata->>'currentStep','')::int,
                NULLIF(metadata->>'current_step','')::int,
                current_step, 1) AS step,
              submitted_at
         FROM applications
        WHERE silo = $1
          AND created_at >= now() - ($2 || ' days')::interval
     )
     SELECT
       count(*)::int AS started,
       count(*) FILTER (WHERE step >= 2 OR submitted_at IS NOT NULL)::int AS step2,
       count(*) FILTER (WHERE step >= 3 OR submitted_at IS NOT NULL)::int AS step3,
       count(*) FILTER (WHERE step >= 4 OR submitted_at IS NOT NULL)::int AS step4,
       count(*) FILTER (WHERE step >= 5 OR submitted_at IS NOT NULL)::int AS step5,
       count(*) FILTER (WHERE step >= 6 OR submitted_at IS NOT NULL)::int AS step6,
       count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted
     FROM a`,
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

// BF_SERVER_MARKETING_GA4_v1 - GA4 traffic/sources/devices via the Analytics Data API.
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

// BF_SERVER_LINKEDIN_ADS_v1 - LinkedIn Ads spend/performance (read).
router.get("/linkedin-ads", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  if (!linkedInAdsConfigured()) { respondOk(res, { configured: false }); return; }
  const report = await runLinkedInAdsReport(days);
  respondOk(res, report ?? { configured: false });
}));

// BF_SERVER_MARKETING_CLARITY_v1 - Microsoft Clarity behavioral analytics (Data Export API).
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

// BF_SERVER_LINKEDIN_CONVERSIONS_v1 - closed-loop funded-deal conversions to LinkedIn.
router.get("/linkedin-ads/conversions/pending", safeHandler(async (_req: any, res: any) => {
  if (!linkedInConversionsConfigured()) { respondOk(res, { configured: false, pending: [] }); return; }
  const pending = await findPendingLinkedInConversions();
  respondOk(res, { configured: true, count: pending.length, pending });
}));
router.post("/linkedin-ads/conversions/upload", safeHandler(async (_req: any, res: any) => {
  const result = await uploadFundedLinkedInConversions();
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

// BF_SERVER_LINKEDIN_AUDIENCE_v1 - LinkedIn Matched Audiences contact list export.
router.post("/linkedin-ads/icp/export", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const type = b.type === "exclusion" ? "exclusion" : "seed";
  const filters = { productCategory: b.productCategory || undefined, minAmount: typeof b.minAmount === "number" ? b.minAmount : undefined, maxAmount: typeof b.maxAmount === "number" ? b.maxAmount : undefined };
  respondOk(res, await buildLinkedInAudienceCsv(silo, filters, type));
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

// BF_SERVER_LINKEDIN_SUGGESTIONS_v1 - Maya LinkedIn campaign recommendations (human-approved).
router.get("/linkedin-ads/suggestions", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  if (!linkedInSuggestionsConfigured()) { respondOk(res, { configured: false, suggestions: [] }); return; }
  respondOk(res, await buildLinkedInSuggestions(days));
}));
router.post("/linkedin-ads/suggestions/apply", safeHandler(async (req: any, res: any) => {
  const action = req.body && req.body.action;
  if (!action || typeof action.type !== "string") { respondOk(res, { ok: false, error: "missing action" }); return; }
  respondOk(res, await applyLinkedInSuggestion(action));
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
    if (!r.ok) console.error("sendgrid_test_failed", { to: b.test, status: r.status, error: r.error });
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  // BF_SERVER_BLOCK_v782_VIEW_IN_BROWSER: host a public copy, inject the link.
  const { url: __viewUrl } = await createLandingPageFromHtml(html, silo, subject, req.user?.userId ?? null);
  const htmlOut = withViewInBrowser(html, __viewUrl);
  // BF_SERVER_SEND_QUEUE_v1 - small blasts send inline (unchanged response);
  // large ones go to the durable background queue (no cap, no request blocking).
  const total = await countEmailRecipients(pool, silo, tag);
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, sent: 0, failed: 0, capped: false }); return; }
  if (total > 500) {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by)
       VALUES ('email', $1, $2, $3, $4, $5) RETURNING id`,
      [silo, tag, JSON.stringify({ subject, html: htmlOut }), total, req.user?.userId ?? null],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total });
    return;
  }
  const out = await runEmailSend(pool, { silo, tag, subject, html: htmlOut });
  respondOk(res, { configured: true, recipients: out.total, sent: out.sent, failed: out.failed, capped: false });
}));

// BF_SERVER_SEND_QUEUE_v1 - background blast job status (for the portal progress UI).
router.get("/send-jobs", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT id, channel, tag, status, total, sent, failed, error, created_at, started_at, finished_at
       FROM marketing_send_jobs WHERE silo = $1 ORDER BY created_at DESC LIMIT 50`,
    [silo],
  );
  respondOk(res, { jobs: r.rows });
}));
router.get("/send-jobs/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT id, channel, tag, status, total, sent, failed, error, created_at, started_at, finished_at
       FROM marketing_send_jobs WHERE id = $1 AND silo = $2`,
    [req.params.id, silo],
  );
  respondOk(res, r.rows[0] || { error: "not found" });
}));

// BF_SERVER_MARKETING_SMS_v1 - bulk SMS + 36h fallback-email cascade (BF silo).
router.get("/sms/segments", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const tags = await pool.query(
    `SELECT tag, count(*)::int AS n FROM (
       SELECT unnest(tags) AS tag FROM contacts
        WHERE silo = $1 AND COALESCE(phone,'') <> '' AND COALESCE(sms_opt_out,false) = false AND (line_type IS NULL OR line_type = 'mobile')
     ) t GROUP BY tag ORDER BY n DESC`,
    [silo],
  );
  const all = await pool.query(`SELECT count(*)::int AS n FROM contacts WHERE silo = $1 AND COALESCE(phone,'') <> '' AND COALESCE(sms_opt_out,false) = false AND (line_type IS NULL OR line_type = 'mobile')`, [silo]);
  respondOk(res, { configured: smsMarketingConfigured(), all: all.rows[0]?.n ?? 0, segments: tags.rows });
}));

router.post("/sms/send", safeHandler(async (req: any, res: any) => {
  if (!smsMarketingConfigured()) { respondOk(res, { configured: false }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const body = String(b.body || "").trim();
  if (!body) { respondOk(res, { error: "message body required" }); return; }
  if (b.test && typeof b.test === "string") {
    const r = await sendMarketingSms(b.test, body);
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  const linkUrl = b.linkUrl ? String(b.linkUrl) : null;
  const fbSubject = b.fallbackSubject ? String(b.fallbackSubject) : null;
  const fbHtml = b.fallbackHtml ? String(b.fallbackHtml) : null;
  // BF_SERVER_SEND_QUEUE_SMS_v1 - small blasts inline; large ones queue (no cap, no blocking).
  const total = await countSmsRecipients(pool, silo, tag);
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, smsSent: 0, emailSent: 0, failed: 0 }); return; }
  if (total > 1000) {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by)
       VALUES ('sms', $1, $2, $3, $4, $5) RETURNING id`,
      [silo, tag, JSON.stringify({ body, linkUrl, fbSubject, fbHtml }), total, req.user?.userId ?? null],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total });
    return;
  }
  const out = await runSmsSend(pool, { silo, tag, body, linkUrl, fbSubject, fbHtml, createdBy: req.user?.userId ?? null });
  respondOk(res, { configured: true, recipients: out.total, smsSent: out.smsSent, emailSent: out.emailSent, failed: out.failed });
}));

router.get("/clarity", safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(Number(req.query.days) || 3, 1), 3);
  if (!clarityConfigured()) { respondOk(res, { configured: false }); return; }
  const report = await runClarityReport(days);
  respondOk(res, report ?? { configured: false });
}));

// BF_EMAIL_TEMPLATE_ROUTES_v1 - branded email template (BF): save/load, image upload, preview, send.
const emailAssetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

async function uploadMarketingImage(buf: Buffer, contentType: string, ext: string): Promise<string | null> {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!conn) return null;
  const containerName = process.env.AZURE_STORAGE_CONTAINER_MARKETING || "marketing-assets";
  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(containerName);
  await container.createIfNotExists({ access: "blob" });
  const blob = container.getBlockBlobClient(`email/${randomUUID()}${ext}`);
  await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType || "application/octet-stream" } });
  return blob.url;
}

function templateFieldsFromBody(b: any): BrandedEmailFields {
  return {
    headline: String(b.headline || ""),
    heroUrl: String(b.heroUrl || ""),
    heroLink: String(b.heroLink || ""),
    body: String(b.body || ""),
    ctaLabel: String(b.ctaLabel || ""),
    ctaUrl: String(b.ctaUrl || ""),
    image2Url: String(b.image2Url || ""),
    image2Link: String(b.image2Link || ""),
  };
}

router.get("/email/template", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`SELECT headline, hero_url, hero_link, body, cta_label, cta_url, image2_url, image2_link FROM marketing_email_template WHERE silo = $1`, [silo]);
  const row: any = r.rows[0] || {};
  respondOk(res, { template: {
    headline: row.headline ?? "", heroUrl: row.hero_url ?? "", heroLink: row.hero_link ?? "",
    body: row.body ?? "", ctaLabel: row.cta_label ?? "", ctaUrl: row.cta_url ?? "",
    image2Url: row.image2_url ?? "", image2Link: row.image2_link ?? "",
  } });
}));

router.post("/email/template", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const f = templateFieldsFromBody(req.body || {});
  await pool.query(
    `INSERT INTO marketing_email_template (silo, headline, hero_url, hero_link, body, cta_label, cta_url, image2_url, image2_link, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (silo) DO UPDATE SET headline=$2, hero_url=$3, hero_link=$4, body=$5, cta_label=$6, cta_url=$7, image2_url=$8, image2_link=$9, updated_at=now()`,
    [silo, f.headline, f.heroUrl, f.heroLink, f.body, f.ctaLabel, f.ctaUrl, f.image2Url, f.image2Link],
  );
  respondOk(res, { saved: true });
}));

router.post("/email/template/preview", safeHandler(async (req: any, res: any) => {
  respondOk(res, { html: renderBrandedEmail(templateFieldsFromBody(req.body || {})) });
}));

router.post("/email/assets/upload", emailAssetUpload.single("file"), safeHandler(async (req: any, res: any) => {
  const file = (req as any).file as { buffer: Buffer; originalname: string; mimetype: string } | undefined;
  if (!file || !file.buffer || !file.buffer.length) { respondOk(res, { error: "no file" }); return; }
  if (!/^image\//.test(file.mimetype || "")) { respondOk(res, { error: "image files only" }); return; }
  try {
    const ext = (path.extname(file.originalname || "") || ".png").toLowerCase();
    const url = await uploadMarketingImage(file.buffer, file.mimetype, ext);
    if (!url) { respondOk(res, { error: "storage not configured" }); return; }
    respondOk(res, { url });
  } catch {
    respondOk(res, { error: "upload failed (check Allow Blob public access)" });
  }
}));

// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - sanitize a tag list from body/query.
function tagArr(v: unknown): string[] | null {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const out = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  return out.length ? out : null;
}

// BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - live recipient count for an
// include/exclude tag combination (branded email composer preview).
router.get("/email/audience-count", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const include = tagArr(req.query.include);
  const exclude = tagArr(req.query.exclude);
  const n = await countEmailRecipients(pool, silo, null, include, exclude);
  respondOk(res, { n });
}));

router.post("/email/send-template", safeHandler(async (req: any, res: any) => {
  if (!sendgridConfigured()) { respondOk(res, { configured: false }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const subject = String(b.subject || "").trim();
  if (!subject) { respondOk(res, { error: "subject required" }); return; }
  const html = renderBrandedEmail(templateFieldsFromBody(b));
  if (b.test && typeof b.test === "string") {
    const vars = { first_name: "there", name: "there", email: b.test, company: "" };
    const r = await sendOne({ to: b.test, subject: mergeFields(subject, vars), html: mergeFields(html, vars) });
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  // BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - multi-tag include/exclude audience.
  const includeTags = tagArr(b.tags);
  const excludeTags = tagArr(b.excludeTags);
  // BF_SERVER_BLOCK_v782_VIEW_IN_BROWSER
  const { url: __viewUrl } = await createLandingPageFromHtml(html, silo, subject, req.user?.userId ?? null);
  const htmlOut = withViewInBrowser(html, __viewUrl);
  const total = await countEmailRecipients(pool, silo, tag, includeTags, excludeTags);
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, sent: 0, failed: 0 }); return; }
  if (total > 500) {
    const job = await pool.query<{ id: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by) VALUES ('email', $1, $2, $3, $4, $5) RETURNING id`,
      [silo, tag, JSON.stringify({ subject, html: htmlOut, tags: includeTags, excludeTags }), total, req.user?.userId ?? null],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total });
    return;
  }
  const out = await runEmailSend(pool, { silo, tag, subject, html: htmlOut, tags: includeTags, excludeTags });
  respondOk(res, { configured: true, recipients: out.total, sent: out.sent, failed: out.failed });
}));

// BF_SERVER_BLOCK_v783_MARKETING_TEMPLATES — named templates per channel.
router.get("/templates", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const channel = String(req.query.channel || "").trim();
  const params: any[] = [silo];
  let where = "silo = $1";
  if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }
  const r = await pool.query(
    `SELECT id, channel, name, body, link_url, subject, updated_at
       FROM marketing_template WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
    params,
  );
  respondOk(res, { items: r.rows });
}));

router.post("/templates", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const channel = String(b.channel || "").trim();
  const name = String(b.name || "").trim();
  if (!channel || !name) { respondOk(res, { error: "channel and name required" }); return; }
  // BF_SERVER_EMAIL_TEMPLATE_LANDING_v1 - an email template also hosts a public landing-page copy
  // and returns its URL, so the operator can paste it into an SMS template for a sequence.
  let landingUrl: string | null = b.linkUrl ?? null;
  if (channel === "email" && b.html) {
    try {
      const lp = await createLandingPageFromHtml(String(b.html), silo, String(b.subject || name || "Boreal"), req.user?.userId ?? null);
      landingUrl = lp.url;
    } catch (e) {
      console.error("email_template_landing_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  const r = await pool.query(
    `INSERT INTO marketing_template (silo, channel, name, body, link_url, subject, html, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [silo, channel, name, b.body ?? null, landingUrl, b.subject ?? null, b.html ?? null, req.user?.userId ?? null],
  );
  respondOk(res, { id: r.rows[0].id, saved: true, landingUrl });
}));

router.delete("/templates/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  await pool.query("DELETE FROM marketing_template WHERE id = $1 AND silo = $2", [String(req.params.id), silo]);
  respondOk(res, { deleted: true });
}));

// BF_SERVER_BLOCK_v785_SEQUENCES — drip sequence CRUD + activate/pause.
router.get("/sequences", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT s.id, s.name, s.audience_tag, s.status, s.stop_on_reply, s.created_at,
            (SELECT count(*)::int FROM marketing_sequence_steps st WHERE st.sequence_id=s.id) AS steps,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id) AS enrolled,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='active') AS active,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='completed') AS completed,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='replied') AS replied,
            (SELECT count(*)::int FROM crm_timeline_events t WHERE t.event_type='sequence_step_sent' AND t.payload->>'sequenceId'=s.id::text AND t.payload->>'channel'='email') AS emails_sent,
            (SELECT count(*)::int FROM crm_timeline_events t WHERE t.event_type='sequence_step_sent' AND t.payload->>'sequenceId'=s.id::text AND t.payload->>'channel'='sms') AS sms_sent,
            (SELECT count(*)::int FROM sequence_sends ss WHERE ss.sequence_id=s.id AND ss.channel='sms' AND ss.clicked_at IS NOT NULL) AS sms_clicks,
            (SELECT count(*)::int FROM sequence_sends ss WHERE ss.sequence_id=s.id AND ss.channel='email' AND ss.opened_at IS NOT NULL) AS email_opens,
            (SELECT count(*)::int FROM sequence_sends ss WHERE ss.sequence_id=s.id AND ss.channel='email' AND ss.clicked_at IS NOT NULL) AS email_clicks,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.sequence_id=s.id AND c.marketing_opt_out=true) AS unsubscribed
       FROM marketing_sequences s WHERE s.silo=$1 ORDER BY s.created_at DESC LIMIT 200`,
    [silo]);
  respondOk(res, { items: r.rows });
}));

router.get("/sequences/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const s = await pool.query(`SELECT id, name, audience_tag, status, stop_on_reply, quiet_start, quiet_end FROM marketing_sequences WHERE id=$1 AND silo=$2`, [String(req.params.id), silo]);
  if (s.rowCount === 0) { respondOk(res, { item: null }); return; }
  const steps = await pool.query(`SELECT step_order, channel, wait_minutes, condition, subject, body, html, link_url, template_id FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`, [String(req.params.id)]);
  respondOk(res, { item: s.rows[0], steps: steps.rows });
}));

router.post("/sequences", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!name || steps.length === 0) { respondOk(res, { error: "name and at least one step required" }); return; }
  const seq = await pool.query(
    `INSERT INTO marketing_sequences (silo, name, audience_tag, stop_on_reply, quiet_start, quiet_end, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [silo, name, b.audienceTag ? String(b.audienceTag) : null, b.stopOnReply !== false, Number(b.quietStart ?? 9), Number(b.quietEnd ?? 21), req.user?.userId ?? null]);
  const seqId = seq.rows[0].id;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    await pool.query(
      `INSERT INTO marketing_sequence_steps (sequence_id, step_order, channel, wait_minutes, condition, subject, body, html, link_url, template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [seqId, i, String(st.channel || "email"), Number(st.waitMinutes ?? 0), String(st.condition || "always"), st.subject ?? null, st.body ?? null, st.html ?? null, st.linkUrl ?? null, st.templateId ?? null]);
  }
  respondOk(res, { id: seqId, saved: true });
}));

router.post("/sequences/:id/activate", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const id = String(req.params.id);
  const upd = await pool.query(`UPDATE marketing_sequences SET status='active', updated_at=now() WHERE id=$1 AND silo=$2 RETURNING id`, [id, silo]);
  if (upd.rowCount === 0) { respondOk(res, { error: "not found" }); return; }
  const enrolled = await enrollSequence(pool, id);
  respondOk(res, { activated: true, enrolled });
}));

router.post("/sequences/:id/pause", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  await pool.query(`UPDATE marketing_sequences SET status='paused', updated_at=now() WHERE id=$1 AND silo=$2`, [String(req.params.id), silo]);
  respondOk(res, { paused: true });
}));

router.delete("/sequences/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const id = String(req.params.id);
  await pool.query(`DELETE FROM marketing_sequence_enrollments WHERE sequence_id=$1`, [id]);
  await pool.query(`DELETE FROM marketing_sequence_steps WHERE sequence_id=$1`, [id]);
  await pool.query(`DELETE FROM marketing_sequences WHERE id=$1 AND silo=$2`, [id, silo]);
  respondOk(res, { deleted: true });
}));

export default router;
