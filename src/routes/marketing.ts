import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { createLandingPage, createLandingPageFromHtml, updateLandingPageHtml, slugFromLandingUrl, landingUrlForSlug, withViewInBrowser } from "../services/landingPage.service.js"; // BF_SERVER_BLOCK_v780_PUBLIC_LANDING
import { sendgridConfigured, sendOne, mergeFields } from "../services/sendgridService.js";
import { smsMarketingConfigured, sendMarketingSms, renderMarketingSms } from "../services/marketingSms.js";
import { SMS_ELIGIBLE_SQL } from "../services/smsConsent.js"; // BF_SERVER_SMS_CONSENT_v1
import { countEmailRecipients, runEmailSend, countSmsRecipients, runSmsSend } from "../services/marketingSendRunner.js"; // BF_SERVER_SEND_QUEUE_v1 BF_SERVER_SEND_QUEUE_SMS_v1
import { enrollContacts, enrollSequence } from "../services/sequenceEngine.js"; // BF_SERVER_BLOCK_v785_SEQUENCES
import { suggestionsConfigured, buildSuggestions, applySuggestion, adsMutateAllowed, ADS_MUTATE_BLOCKED_REASON } from "../services/googleAdsSuggestions.js"; // BF_SERVER_ADS_WRITE_GATE_v56
import { linkedInSuggestionsConfigured, buildLinkedInSuggestions, applyLinkedInSuggestion } from "../services/linkedInAdsSuggestions.js"; // BF_SERVER_LINKEDIN_SUGGESTIONS_v1
import { previewIcp, buildHashedList, buildLinkedInAudienceCsv } from "../services/googleAdsCustomerMatch.js";
import { ga4Configured, runGa4Report } from "../services/ga4Service.js";
import { clarityConfigured, runClarityReport } from "../services/clarityService.js";
import { conversionsConfigured, findPendingConversions, uploadFundedConversions, submitConversionsConfigured, findPendingSubmitConversions, uploadSubmitConversions } from "../services/googleAdsConversions.js";
import { linkedInConversionsConfigured, findPendingLinkedInConversions, uploadFundedLinkedInConversions } from "../services/linkedInAdsConversions.js"; // BF_SERVER_LINKEDIN_CONVERSIONS_v1
import { googleAdsConfigured, runGoogleAdsReport } from "../services/googleAdsService.js";
import { linkedInAdsConfigured, runLinkedInAdsReport } from "../services/linkedInAdsService.js"; // BF_SERVER_LINKEDIN_ADS_v1
// BF_EMAIL_TEMPLATE_IMPORTS_v1
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { renderBrandedEmail, type BrandedEmailFields } from "../services/emailTemplateRender.js";
import { resolveScheduledAt, SendScheduleError } from "../services/sendSchedule.js"; // BF_SERVER_SEND_LATER_v35


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
// BF_SERVER_SEND_HOLD_WINDOW_v1 - every queued blast is held this long before
// the worker will send it, so staff can cancel. 5 minutes.
const SEND_HOLD_MINUTES = 5;
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
          -- BF_SERVER_FUNNEL_COUNT_STEP1_v79
          -- v1 of this filter excluded every "Draft application" still sitting on
          -- step 1, to make "started" agree with GA4's form_start count. But a blank
          -- draft is not a phantom: /api/public/application/start only creates one
          -- AFTER the applicant has passed phone OTP. Each row is a verified human
          -- who reached step 1 and stopped. Excluding them made the chart tidier and
          -- hid the single most callable cohort in the business - the funnel showed
          -- 10 starts against 15 phone-verified contacts tagged application_started.
          -- They are counted. The step 1 -> step 2 drop is where they now show up,
          -- which is exactly where the problem actually is.
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
    // BF_SERVER_MARKETING_SOURCE_HYGIENE_v1 - "Step 6 - Review" and "Submitted"
    // are the same event: step 6 IS the review page, and submitting is the only
    // thing you do on it. They therefore always rendered an identical count and
    // identical percentage, which reads as a broken chart rather than a funnel.
    // Keep the outcome row, drop the duplicate.
    { key: "submitted", label: "Step 6 \u00b7 Review \u0026 submit", count: Number(r.submitted) },
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
// BF_SERVER_ABANDONED_LIST_v79
// Every applicant who passed phone OTP, started, and never submitted - with how far
// they got and how to reach them. This is a work queue, not a report: the whole point
// is that these people are contactable and nobody has contacted them.
// ?days=90&maxStep=6
// BF_SERVER_ABANDONED_EXCLUDE_v85
// Staff numbers that appear in the abandoned list only because they were used to
// test the wizard. Set ABANDONED_EXCLUDE_PHONES to a comma-separated list to add
// more without a deploy; the default covers Todd's mobile, which accounted for
// roughly half the rows. Stored as bare last-10 digits to match the SQL.
const EXCLUDED_ABANDONED_PHONES: string[] = String(
  process.env.ABANDONED_EXCLUDE_PHONES ?? "5878881837",
)
  .split(",")
  .map((v) => v.replace(/[^0-9]/g, "").slice(-10))
  .filter((v) => v.length === 10);

router.get("/abandoned", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query(
    `SELECT a.id,
            COALESCE(
              NULLIF(a.metadata->>'currentStep','')::int,
              NULLIF(a.metadata->>'current_step','')::int,
              a.current_step, 1) AS step,
            a.created_at,
            a.updated_at,
            a.requested_amount,
            a.product_category,
            a.contact_id,
            c.name  AS contact_name,
            c.phone AS contact_phone,
            c.email AS contact_email,
            NULLIF(a.metadata->'attribution'->>'gclid','')      AS gclid,
            NULLIF(a.metadata->'attribution'->>'utm_source','') AS utm_source,
            NULLIF(a.metadata->'attribution'->>'utm_campaign','') AS utm_campaign,
            a.abandon_sms_sent_at
       FROM applications a
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.silo = $1
        AND a.submitted_at IS NULL
        AND a.created_at >= now() - ($2 || ' days')::interval
        -- BF_SERVER_ABANDONED_EXCLUDE_v85
        -- This is a call list, so a row nobody can be called on is noise. Two
        -- classes were burying the real leads: applications with no contact or a
        -- blank phone (wizard loads that never reached OTP - 63 rows, most of them
        -- unreachable), and staff test runs. Both are dropped in SQL rather than
        -- in the UI so the count in the header is the count you can actually work.
        AND c.phone IS NOT NULL
        AND btrim(c.phone) <> ''
        -- Compare on the last 10 digits: the column holds a mix of E.164 and
        -- national formats, so a literal string match would miss half of them.
        AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10) <> ALL($3::text[])
      ORDER BY a.updated_at DESC
      LIMIT 200`,
    [silo, String(days), EXCLUDED_ABANDONED_PHONES],
  );
  const items = rows.map((r: any) => ({
    applicationId: r.id,
    step: Number(r.step) || 1,
    contactId: r.contact_id,
    name: r.contact_name,
    phone: r.contact_phone,
    email: r.contact_email,
    amount: r.requested_amount,
    product: r.product_category,
    source: r.gclid ? "google / cpc" : (r.utm_source || "direct"),
    campaign: r.utm_campaign,
    startedAt: r.created_at,
    lastActivityAt: r.updated_at,
    nudgedAt: r.abandon_sms_sent_at,
  }));
  const byStep: Record<string, number> = {};
  for (const i of items) byStep[String(i.step)] = (byStep[String(i.step)] || 0) + 1;
  respondOk(res, { days, count: items.length, byStep, items });
}));

router.get("/sources", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query<{ source: string; started: number; submitted: number }>(
    // BF_SERVER_MARKETING_SOURCE_HYGIENE_v1
    // When no utm_source is present this falls back to the referrer host. That
    // meant our OWN domains showed up as acquisition sources: an applicant who
    // navigated from boreal.financial to client.boreal.financial was reported as
    // having been "referred by client.boreal.financial", sitting in the channel
    // list next to Google and organic. Self-referral is not acquisition - it is
    // internal navigation - and it both invents a channel and steals volume from
    // the real one.
    //
    // Internal hosts now fall through to 'direct', which is what an untagged
    // visit actually is. Matching is on the registrable domain so any subdomain
    // (www, client, staff, server) is covered without listing each.
    // BF_SERVER_GCLID_IS_A_SOURCE_v78
    // This resolved a source from utm_source, then the referrer host, then gave up
    // and said 'direct'. Google auto-tagging appends gclid and does NOT append
    // utm_source, so every single paid click - correctly captured, correctly
    // forwarded across the domain hop, correctly stored on the application - was
    // reported as direct. The Conversion by Source panel showed one row, 'direct',
    // against real ad spend, and there was no way to tell a paid application from
    // a typed-in-the-URL one. gclid/gbraid/wbraid now resolve first.
    `SELECT
       COALESCE(
         CASE WHEN COALESCE(metadata->'attribution'->>'gclid','')  <> '' THEN 'google / cpc'
              WHEN COALESCE(metadata->'attribution'->>'gbraid','') <> '' THEN 'google / cpc'
              WHEN COALESCE(metadata->'attribution'->>'wbraid','') <> '' THEN 'google / cpc'
              WHEN COALESCE(metadata->'attribution'->>'li_fat_id','') <> '' THEN 'linkedin / cpc'
         END,
         NULLIF(metadata->'attribution'->>'utm_source', ''),
         NULLIF(
           CASE
             WHEN split_part(
                    split_part(COALESCE(metadata->'attribution'->>'referrer',''), '//', 2),
                    '/', 1)
                  ILIKE ANY (ARRAY['%boreal.financial', '%boreal.insure', '%canadianbusinessfinancing.com'])
               THEN ''
             ELSE split_part(
                    split_part(COALESCE(metadata->'attribution'->>'referrer',''), '//', 2),
                    '/', 1)
           END, '') ,
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

// BF_SERVER_ATTRIBUTION_HEALTH_v78
// Every attribution question so far has been answered by inference. This answers it
// with counts: of the applications created in the window, how many actually carry a
// gclid, a utm_source, and a journey session id - and how many are queued for or
// already uploaded to Google Ads as conversions. If gclidCount is 0 the capture chain
// is broken upstream; if it is non-zero the chain works and only reporting was wrong.
router.get("/attribution-health", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted,
       count(*) FILTER (WHERE COALESCE(metadata->'attribution'->>'gclid','') <> '')::int AS with_gclid,
       count(*) FILTER (WHERE COALESCE(metadata->'attribution'->>'gbraid','') <> ''
                           OR COALESCE(metadata->'attribution'->>'wbraid','') <> '')::int AS with_braid,
       count(*) FILTER (WHERE COALESCE(metadata->'attribution'->>'utm_source','') <> '')::int AS with_utm,
       count(*) FILTER (WHERE COALESCE(metadata->'attribution'->>'sessionId','') <> '')::int AS with_journey,
       count(*) FILTER (WHERE metadata->'attribution' IS NULL)::int AS no_attribution_at_all,
       count(*) FILTER (WHERE submitted_at IS NOT NULL
                          AND COALESCE(metadata->'attribution'->>'gclid','') <> ''
                          AND metadata->'ad_submit_conversion_uploaded_at' IS NULL)::int AS submit_conversions_pending,
       count(*) FILTER (WHERE metadata->'ad_submit_conversion_uploaded_at' IS NOT NULL)::int AS submit_conversions_uploaded
     FROM applications
     WHERE silo = $1
       AND created_at >= now() - ($2 || ' days')::interval`,
    [silo, String(days)],
  );
  const stitched = await pool.query(
    `SELECT count(*)::int AS sessions,
            count(*) FILTER (WHERE contact_id IS NOT NULL)::int AS stitched
       FROM visitor_sessions
      WHERE first_seen_at >= now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  respondOk(res, { days, applications: rows[0], journey: stitched.rows[0] });
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

// BF_SERVER_ADS_SUBMIT_ROUTES_v1 - submitted-application conversions use a
// separate action from funded uploads so both can apply to one application.
router.get("/google-ads/conversions/submit-pending", safeHandler(async (_req: any, res: any) => {
  if (!submitConversionsConfigured()) { respondOk(res, { configured: false, pending: [] }); return; }
  const pending = await findPendingSubmitConversions();
  respondOk(res, { configured: true, count: pending.length, pending });
}));
router.post("/google-ads/conversions/submit-upload", safeHandler(async (_req: any, res: any) => {
  const result = await uploadSubmitConversions();
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
  // BF_SERVER_ADS_WRITE_GATE_v56 - a 403, not a 200 with ok:false, so a blocked
  // attempt is visible rather than looking like an ordinary failed apply.
  if (!adsMutateAllowed()) {
    res.status(403).json({ ok: false, error: "ads_mutate_disabled", message: ADS_MUTATE_BLOCKED_REASON });
    return;
  }
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

// BF_SERVER_TEST_SEND_REAL_CONTACT_v26 - test sends hardcoded
// { first_name: "there" }, so staff could never see what a real recipient would
// get and reasonably read it as the CRM lookup being broken. It was not: real
// campaign sends merge correctly. Resolve the test recipient against contacts in
// the same silo - by email for email tests, by phone digits for SMS - and fall
// back to the old literal only when nothing matches.
async function testSendVars(silo: string, target: string, channel: "email" | "sms") {
  const fallback = { first_name: "there", name: "there", email: channel === "email" ? target : "", company: "" };
  try {
    const digits = target.replace(/\D/g, "");
    const r = channel === "email"
      ? await pool.query(
          `SELECT c.name, c.first_name, c.last_name, c.email, co.name AS company
             FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
            WHERE c.silo = $1 AND lower(c.email) = lower($2) LIMIT 1`,
          [silo, target])
      : await pool.query(
          `SELECT c.name, c.first_name, c.last_name, c.email, co.name AS company
             FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
            WHERE c.silo = $1
              AND right(regexp_replace(COALESCE(c.phone,''), '[^0-9]', '', 'g'), 10) = right($2, 10)
            LIMIT 1`,
          [silo, digits]);
    const row = r.rows[0];
    if (!row) return fallback;
    // BF_SERVER_TEST_SEND_NAME_COLUMN_v29 - prefer the same source the real send
    // uses. first_name/last_name are NULL on rows created after the v303
    // backfill, so reading them alone silently produced the "there" fallback for
    // contacts that merge perfectly well in a live campaign.
    // BF_SERVER_CI_GREEN_AND_NAME_PRECEDENCE_v30 - contacts.name is what the live
    // send merges from, so it must win outright. first_name/last_name are the
    // fallback for rows where name is blank, not the other way round.
    const split = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
    const full = String(row.name || "").trim() || split;
    return {
      first_name: full.split(/\s+/)[0] || String(row.first_name || "").trim() || "there",
      name: full || "there",
      email: String(row.email || (channel === "email" ? target : "")),
      company: String(row.company || ""),
    };
  } catch {
    return fallback;
  }
}

router.post("/email/send", safeHandler(async (req: any, res: any) => {
  if (!sendgridConfigured()) { respondOk(res, { configured: false, error: "sendgrid_not_configured", message: "SendGrid is not configured; no email was sent." }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const subject = String(b.subject || "").trim();
  const html = String(b.html || "").trim();
  if (!subject || !html) { respondOk(res, { error: "subject and html required" }); return; }
  if (b.test && typeof b.test === "string") {
    const vars = await testSendVars(silo, String(b.test), "email"); // BF_SERVER_TEST_SEND_REAL_CONTACT_v26
    const r = await sendOne({ to: b.test, subject: mergeFields(subject, vars), html: mergeFields(html, vars) });
    if (!r.ok) console.error("sendgrid_test_failed", { to: b.test, status: r.status, error: r.error });
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  const templateId = b.templateId ? String(b.templateId) : null; // BF_SERVER_TEMPLATE_ANALYTICS_v1
  // BF_SERVER_EMAIL_HARDENING_v1 - raw email panel gains include/exclude tag
  // parity with the branded composer; previously b.tags/b.excludeTags were
  // silently dropped here and the blast targeted the whole silo.
  const includeTags = tagArr(b.tags);
  const excludeTags = tagArr(b.excludeTags);
  // BF_SERVER_BLOCK_v782_VIEW_IN_BROWSER: host a public copy, inject the link.
  // BF_SERVER_EMAIL_HARDENING_v1 - landing hosting is best-effort; a failed
  // insert must not 500 the whole blast.
  let htmlOut = html;
  try {
    const { url: __viewUrl } = await createLandingPageFromHtml(html, silo, subject, req.user?.userId ?? null);
    htmlOut = withViewInBrowser(html, __viewUrl);
  } catch (e) { console.error("landing_page_failed", { error: e instanceof Error ? e.message : String(e) }); }
  // BF_SERVER_SEND_QUEUE_v1 - small blasts send inline (unchanged response);
  // large ones go to the durable background queue (no cap, no request blocking).
  const total = await countEmailRecipients(pool, silo, tag, includeTags, excludeTags);
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, sent: 0, failed: 0, capped: false }); return; }
  if (total > 0) { // BF_SERVER_ALWAYS_QUEUE_v1 - always use the durable queue; inline sends cannot resume
    // BF_SERVER_SEND_LATER_v35
    let schedule;
    try {
      schedule = resolveScheduledAt((req.body ?? {}).sendAt, SEND_HOLD_MINUTES);
    } catch (err) {
      if (err instanceof SendScheduleError) {
        res.status(400).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
    const job = await pool.query<{ id: string; not_before: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by, not_before)
       VALUES ('email', $1, $2, $3, $4, $5, $6::timestamptz) RETURNING id, not_before`,
      // BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - `resend` rides along in the payload
      // so the worker that picks this job up honours it too.
      [silo, tag, JSON.stringify({ subject, html: htmlOut, tags: includeTags, excludeTags, templateId, resend: b.resend === true }), total, req.user?.userId ?? null, schedule.at.toISOString()],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total, notBefore: job.rows[0].not_before, holdMinutes: SEND_HOLD_MINUTES, scheduled: schedule.scheduled });
    return;
  }
  const out = await runEmailSend(pool, { silo, tag, subject, html: htmlOut, resend: b.resend === true, tags: includeTags, excludeTags, templateId });
  respondOk(res, { configured: true, recipients: out.total, sent: out.sent, failed: out.failed, rejected: out.failed, rejectStatus: out.rejectStatus, rejectError: out.rejectError, capped: false });
}));

// BF_SERVER_SEND_QUEUE_v1 - background blast job status (for the portal progress UI).
router.get("/send-jobs", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  // BF_SERVER_SEND_JOBS_SUBJECT_v36 - the portal renders the campaign name from
  // `subject`. BF never selected it, so every BF row fell back to `tag` (empty on
  // a whole-silo blast) and rendered "(untitled)". The subject lives in payload.
  const r = await pool.query(
    `SELECT id, channel, tag, status, total, sent, failed, error, created_at, started_at, finished_at, not_before,
            cancel_requested, payload->>'subject' AS subject, payload->>'templateId' AS template_id
       FROM marketing_send_jobs WHERE silo = $1 ORDER BY created_at DESC LIMIT 50`,
    [silo],
  );
  respondOk(res, { jobs: r.rows });
}));
router.get("/send-jobs/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT id, channel, tag, status, total, sent, failed, error, created_at, started_at, finished_at, not_before,
            cancel_requested, payload->>'subject' AS subject, payload->>'templateId' AS template_id
       FROM marketing_send_jobs WHERE id = $1 AND silo = $2`,
    [req.params.id, silo],
  );
  respondOk(res, r.rows[0] || { error: "not found" });
}));

// BF_SERVER_SEND_HOLD_WINDOW_v1 - cancel a queued blast during its hold window.
// BF_SERVER_SEND_KILL_SWITCH_v1 - a queued job (hold window, not started) is
// canceled outright; a running job is flagged cancel_requested so the send
// runner aborts between recipients within ~50 sends.
router.post("/send-jobs/:id/cancel", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const q = await pool.query(
    `UPDATE marketing_send_jobs
        SET status='canceled', finished_at=now(), updated_at=now()
      WHERE id = $1 AND silo = $2 AND status='queued' AND started_at IS NULL
      RETURNING id`,
    [req.params.id, silo],
  );
  if (q.rows[0]) { respondOk(res, { canceled: true, id: q.rows[0].id, phase: "held" }); return; }
  const run = await pool.query(
    `UPDATE marketing_send_jobs
        SET cancel_requested=true, updated_at=now()
      WHERE id = $1 AND silo = $2 AND status='running'
      RETURNING id`,
    [req.params.id, silo],
  );
  if (run.rows[0]) { respondOk(res, { canceled: true, id: run.rows[0].id, phase: "stopping" }); return; }
  // BF_SERVER_CANCEL_REASON_v36 - a 200 with canceled:false and no status left
  // the portal unable to explain why the row would not go away. Report the
  // terminal status so the UI can say what actually happened.
  const cur = await pool.query<{ status: string }>(
    `SELECT status FROM marketing_send_jobs WHERE id = $1 AND silo = $2`,
    [req.params.id, silo],
  );
  const status = cur.rows[0]?.status ?? null;
  respondOk(res, { canceled: false, status, reason: status ? "already finished" : "not found" });
}));

// BF_SERVER_MARKETING_SMS_v1 - bulk SMS + 36h fallback-email cascade (BF silo).
// BF_SERVER_SMS_AUDIENCE_INCL_EXCL_v1 - tag segments for SMS, parity with email, and the
// counts now reflect CASL eligibility. `all` is who we may lawfully text today;
// `ineligible` is the gap, so the portal shows why the audience shrank instead of
// silently shipping a smaller number.
router.get("/sms/segments", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const tags = await pool.query(
    `SELECT tag, count(*)::int AS n FROM (
       SELECT unnest(c.tags) AS tag FROM contacts c
        WHERE c.silo = $1 AND ${SMS_ELIGIBLE_SQL}
     ) t GROUP BY tag ORDER BY n DESC`,
    [silo],
  );
  const all = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts c WHERE c.silo = $1 AND ${SMS_ELIGIBLE_SQL}`, [silo]);
  const withMobile = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts c
      WHERE c.silo = $1 AND COALESCE(c.phone,'') <> '' AND (c.line_type IS NULL OR c.line_type = 'mobile')`, [silo]);
  const eligible = all.rows[0]?.n ?? 0;
  const mobiles = withMobile.rows[0]?.n ?? 0;
  respondOk(res, {
    configured: smsMarketingConfigured(),
    all: eligible,
    segments: tags.rows,
    mobiles,
    ineligible: Math.max(0, mobiles - eligible),
  });
}));

router.post("/sms/send", safeHandler(async (req: any, res: any) => {
  if (!smsMarketingConfigured()) { respondOk(res, { configured: false }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const body = String(b.body || "").trim();
  if (!body) { respondOk(res, { error: "message body required" }); return; }
  if (b.test && typeof b.test === "string") {
    const text = renderMarketingSms({
      body,
      vars: await testSendVars(silo, String(b.test), "sms"), // BF_SERVER_TEST_SEND_REAL_CONTACT_v26
      link: b.linkUrl ? String(b.linkUrl) : null,
    });
    const r = await sendMarketingSms(b.test, text);
    respondOk(res, { test: true, preview: text, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  const templateId = b.templateId ? String(b.templateId) : null; // BF_SERVER_TEMPLATE_ANALYTICS_v1
  const linkUrl = b.linkUrl ? String(b.linkUrl) : null;
  const fbSubject = b.fallbackSubject ? String(b.fallbackSubject) : null;
  const fbHtml = b.fallbackHtml ? String(b.fallbackHtml) : null;
  const includeTags = tagArr(b.tags);       // BF_SERVER_SMS_AUDIENCE_INCL_EXCL_v1
  const excludeTags = tagArr(b.excludeTags);
  // BF_SERVER_SEND_QUEUE_SMS_v1 - small blasts inline; large ones queue (no cap, no blocking).
  // BF_SERVER_SMS_CASCADE_COMPLETE_v12 - the audience is wider when a fallback
  // email exists, so the number shown must be computed the same way.
  const total = await countSmsRecipients(pool, silo, tag, includeTags, excludeTags, Boolean(fbHtml));
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, smsSent: 0, emailSent: 0, failed: 0 }); return; }
  if (total > 1000) {
    // BF_SERVER_SEND_LATER_v35
    let schedule;
    try {
      schedule = resolveScheduledAt((req.body ?? {}).sendAt, SEND_HOLD_MINUTES);
    } catch (err) {
      if (err instanceof SendScheduleError) {
        res.status(400).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
    const job = await pool.query<{ id: string; not_before: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by, not_before)
       VALUES ('sms', $1, $2, $3, $4, $5, $6::timestamptz) RETURNING id, not_before`,
      [silo, tag, JSON.stringify({ body, linkUrl, fbSubject, fbHtml, templateId, tags: includeTags, excludeTags }), total, req.user?.userId ?? null, schedule.at.toISOString()],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total, notBefore: job.rows[0].not_before, holdMinutes: SEND_HOLD_MINUTES, scheduled: schedule.scheduled });
    return;
  }
  const out = await runSmsSend(pool, { silo, tag, body, linkUrl, fbSubject, fbHtml, createdBy: req.user?.userId ?? null, templateId, tags: includeTags, excludeTags });
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
    // BF_EMAIL_TWO_COLUMN_FIELDS_v1 - templateFieldsFromBody is the ONLY path
    // from composer payload to renderBrandedEmail. The renderer accepts the
    // second column under three alias sets (headline2/body2, secondHeadline/
    // secondBody, rightHeadline/rightBody) but this mapper forwarded NONE of
    // them, so a second column typed in the composer was silently dropped from
    // both the preview and the send. Forward the canonical pair plus the
    // right-hand image, and accept any alias the caller sends.
    headline2: String(b.headline2 || b.secondHeadline || b.rightHeadline || b.column2Headline || ""),
    body2: String(b.body2 || b.secondBody || b.rightBody || b.column2Body || ""),
    rightImageUrl: String(b.rightImageUrl || b.column2ImageUrl || ""),
    rightImageLink: String(b.rightImageLink || b.column2ImageLink || ""),
    cta2Label: String(b.cta2Label || ""),
    cta2Url: String(b.cta2Url || ""),
  };
}

router.get("/email/template", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(`SELECT headline, hero_url, hero_link, body, cta_label, cta_url, image2_url, image2_link, headline2, body2, right_image_url, right_image_link, cta2_label, cta2_url FROM marketing_email_template WHERE silo = $1`, [silo]);
  const row: any = r.rows[0] || {};
  // BF_EMAIL_TEMPLATE_SECOND_COLUMN_v1 - a one-column template stores these
  // empty and reloads as one column; a two-column template reloads with both.
  respondOk(res, { template: {
    headline: row.headline ?? "", heroUrl: row.hero_url ?? "", heroLink: row.hero_link ?? "",
    body: row.body ?? "", ctaLabel: row.cta_label ?? "", ctaUrl: row.cta_url ?? "",
    image2Url: row.image2_url ?? "", image2Link: row.image2_link ?? "",
    headline2: row.headline2 ?? "", body2: row.body2 ?? "",
    rightImageUrl: row.right_image_url ?? "", rightImageLink: row.right_image_link ?? "",
    cta2Label: row.cta2_label ?? "", cta2Url: row.cta2_url ?? "",
  } });
}));

router.post("/email/template", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const f = templateFieldsFromBody(req.body || {});
  await pool.query(
    `INSERT INTO marketing_email_template (silo, headline, hero_url, hero_link, body, cta_label, cta_url, image2_url, image2_link, headline2, body2, right_image_url, right_image_link, cta2_label, cta2_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
     ON CONFLICT (silo) DO UPDATE SET headline=$2, hero_url=$3, hero_link=$4, body=$5, cta_label=$6, cta_url=$7, image2_url=$8, image2_link=$9, headline2=$10, body2=$11, right_image_url=$12, right_image_link=$13, cta2_label=$14, cta2_url=$15, updated_at=now()`,
    [silo, f.headline, f.heroUrl, f.heroLink, f.body, f.ctaLabel, f.ctaUrl, f.image2Url, f.image2Link,
     f.headline2 ?? "", f.body2 ?? "", f.rightImageUrl ?? "", f.rightImageLink ?? "",
     f.cta2Label ?? "", f.cta2Url ?? ""],
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
  if (!sendgridConfigured()) { respondOk(res, { configured: false, error: "sendgrid_not_configured", message: "SendGrid is not configured; no email was sent." }); return; }
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const subject = String(b.subject || "").trim();
  if (!subject) { respondOk(res, { error: "subject required" }); return; }
  const html = renderBrandedEmail(templateFieldsFromBody(b));
  if (b.test && typeof b.test === "string") {
    const vars = await testSendVars(silo, String(b.test), "email"); // BF_SERVER_TEST_SEND_REAL_CONTACT_v26
    const r = await sendOne({ to: b.test, subject: mergeFields(subject, vars), html: mergeFields(html, vars) });
    respondOk(res, { test: true, ...r });
    return;
  }
  const tag = b.tag ? String(b.tag) : null;
  const templateId = b.templateId ? String(b.templateId) : null; // BF_SERVER_TEMPLATE_ANALYTICS_SENDTPL_v1
  // BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 - multi-tag include/exclude audience.
  const includeTags = tagArr(b.tags);
  const excludeTags = tagArr(b.excludeTags);
  // BF_SERVER_BLOCK_v782_VIEW_IN_BROWSER
  // BF_SERVER_EMAIL_HARDENING_v1 - landing hosting is best-effort here too.
  let htmlOut = html;
  try {
    const { url: __viewUrl } = await createLandingPageFromHtml(html, silo, subject, req.user?.userId ?? null);
    htmlOut = withViewInBrowser(html, __viewUrl);
  } catch (e) { console.error("landing_page_failed", { error: e instanceof Error ? e.message : String(e) }); }
  const total = await countEmailRecipients(pool, silo, tag, includeTags, excludeTags);
  if (total === 0) { respondOk(res, { configured: true, recipients: 0, sent: 0, failed: 0 }); return; }
  if (total > 0) { // BF_SERVER_ALWAYS_QUEUE_v1 - always use the durable queue; inline sends cannot resume
    // BF_SERVER_SEND_LATER_v35
    let schedule;
    try {
      schedule = resolveScheduledAt((req.body ?? {}).sendAt, SEND_HOLD_MINUTES);
    } catch (err) {
      if (err instanceof SendScheduleError) {
        res.status(400).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
    const job = await pool.query<{ id: string; not_before: string }>(
      `INSERT INTO marketing_send_jobs (channel, silo, tag, payload, total, created_by, not_before) VALUES ('email', $1, $2, $3, $4, $5, $6::timestamptz) RETURNING id, not_before`,
      // BF_SERVER_EMAIL_TWO_COLUMN_ONLY_v15 - `resend` rides along in the payload
      // so the worker that picks this job up honours it too.
      [silo, tag, JSON.stringify({ subject, html: htmlOut, tags: includeTags, excludeTags, templateId, resend: b.resend === true }), total, req.user?.userId ?? null, schedule.at.toISOString()],
    );
    respondOk(res, { configured: true, queued: true, jobId: job.rows[0].id, total, notBefore: job.rows[0].not_before, holdMinutes: SEND_HOLD_MINUTES, scheduled: schedule.scheduled });
    return;
  }
  const out = await runEmailSend(pool, { silo, tag, subject, html: htmlOut, resend: b.resend === true, tags: includeTags, excludeTags, templateId }); // BF_SERVER_TEMPLATE_ANALYTICS_SENDTPL_v1
  respondOk(res, { configured: true, recipients: out.total, sent: out.sent, failed: out.failed, rejected: out.failed, rejectStatus: out.rejectStatus, rejectError: out.rejectError });
}));

// BF_SERVER_BLOCK_v783_MARKETING_TEMPLATES — named templates per channel.
router.get("/templates", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const channel = String(req.query.channel || "").trim();
  const params: any[] = [silo];
  let where = "silo = $1";
  if (channel) { params.push(channel); where += ` AND channel = $${params.length}`; }
  // BF_SERVER_EMAIL_TEMPLATE_FULL_FIELDS_v1 - also return html and link_url so the composer can restore the
  // full template (headline/hero/CTA live inside html) and show the landing URL
  // on pick. Previously only body+subject came back.
  const r = await pool.query(
    `SELECT id, channel, name, body, link_url, subject, html, fields, updated_at
       FROM marketing_template WHERE ${where} ORDER BY updated_at DESC LIMIT 200`,
    params,
  );
  // BF_SERVER_TEMPLATE_LANDING_BACKFILL_v28 - v25 rebuilt the URL on save only,
  // so a row written while LANDING_BASE_URL was wrong kept displaying the broken
  // string every time the template was loaded. Rebuild on read as well: the slug
  // is the only durable part, the host is always derived from current config.
  respondOk(res, {
    items: r.rows.map((row: any) => {
      const slug = slugFromLandingUrl(row.link_url);
      return { ...row, landingUrl: slug ? landingUrlForSlug(slug) : (row.link_url ?? null) };
    }),
  });
}));

router.post("/templates", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const channel = String(b.channel || "").trim();
  const name = String(b.name || "").trim();
  if (!channel || !name) { respondOk(res, { error: "channel and name required" }); return; }
  // BF_SERVER_EMAIL_TEMPLATE_LANDING_v1 - an email template also hosts a public landing-page copy
  // and returns its URL, so the operator can paste it into an SMS template for a sequence.
  // BF_SERVER_TEMPLATE_SAVE_BY_NAME_v18 - saving under an existing name UPDATES
  // that template instead of inserting a second one. There is no unique index on
  // (silo, channel, name) and none is added here: a UNIQUE migration would fail
  // outright on any duplicates already in the table and a failed migration
  // crash-loops the App Service. Resolving by lookup is safe on dirty data.
  const prior = await pool.query(
    `SELECT id, link_url FROM marketing_template
      WHERE silo = $1 AND channel = $2 AND name = $3
      ORDER BY updated_at DESC LIMIT 1`,
    [silo, channel, name],
  );
  const priorRow = prior.rows[0] ?? null;

  let landingUrl: string | null = b.linkUrl ?? null;
  if (channel === "email" && b.html) {
    try {
      const priorSlug = slugFromLandingUrl(priorRow?.link_url);
      const title = String(b.subject || name || "Boreal");
      // Rewrite the existing page in place so links already sent stay live and
      // show the current copy. Fall through to a new page if the slug is gone.
      if (priorSlug && await updateLandingPageHtml(priorSlug, String(b.html), title)) {
        // BF_SERVER_LANDING_URL_REBUILD_v25 - rebuild from the current base
        // instead of trusting the stored string. Keeping the slug means links
        // already sent stay live; rebuilding the host means a value written
        // while LANDING_BASE_URL was wrong self-heals on the next save.
        landingUrl = landingUrlForSlug(priorSlug);
      } else {
        const lp = await createLandingPageFromHtml(String(b.html), silo, title, req.user?.userId ?? null);
        landingUrl = lp.url;
      }
    } catch (e) {
      console.error("email_template_landing_failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
  // BF_SERVER_TEMPLATE_FIELDS_ROUNDTRIP_v17 - persist the whole composer state.
  // Without this only subject/body/html survived, so loading a saved template
  // left the previous template's headline, images and buttons in the form and
  // the right column empty.
  const fields = b.fields && typeof b.fields === "object" ? JSON.stringify(b.fields) : null;
  let id: string;
  let replaced = false;
  if (priorRow) {
    await pool.query(
      `UPDATE marketing_template
          SET body = $2, link_url = $3, subject = $4, html = $5, fields = $6, updated_at = now()
        WHERE id = $1`,
      [priorRow.id, b.body ?? null, landingUrl, b.subject ?? null, b.html ?? null, fields],
    );
    id = priorRow.id;
    replaced = true;
  } else {
    const r = await pool.query(
      `INSERT INTO marketing_template (silo, channel, name, body, link_url, subject, html, fields, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [silo, channel, name, b.body ?? null, landingUrl, b.subject ?? null, b.html ?? null, fields, req.user?.userId ?? null],
    );
    id = r.rows[0].id;
  }
  respondOk(res, { id, saved: true, landingUrl, replaced });
}));

// BF_SERVER_EMAIL_LINK_CLICKS_v19 - which links people actually clicked.
// GET /api/marketing/link-clicks            -> every link, last 90 days
// GET /api/marketing/link-clicks?templateId= -> one template
// GET /api/marketing/link-clicks?days=30
router.get("/link-clicks", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const templateId = String(req.query.templateId || "").trim();
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  const params: any[] = [silo, days];
  let where = "silo = $1 AND clicked_at > now() - ($2 || ' days')::interval";
  if (templateId) { params.push(templateId); where += ` AND template_id = $${params.length}`; }
  const r = await pool.query(
    `SELECT url,
            count(*)::int AS clicks,
            count(DISTINCT contact_id)::int AS contacts,
            max(clicked_at) AS last_clicked
       FROM email_link_clicks
      WHERE ${where}
      GROUP BY url
      ORDER BY clicks DESC, last_clicked DESC
      LIMIT 200`,
    params,
  );
  respondOk(res, { items: r.rows, days, templateId: templateId || null });
}));

// BF_SERVER_EMAIL_LINK_CLICKS_v19 - who clicked one specific link.
router.get("/link-clicks/contacts", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const url = String(req.query.url || "").trim();
  if (!url) { respondOk(res, { items: [] }); return; }
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  const r = await pool.query(
    `SELECT c.id, c.first_name, c.last_name, c.email,
            count(*)::int AS clicks,
            max(e.clicked_at) AS last_clicked
       FROM email_link_clicks e
       JOIN contacts c ON c.id::text = e.contact_id
      WHERE e.silo = $1 AND e.url = $2
        AND e.clicked_at > now() - ($3 || ' days')::interval
      GROUP BY c.id, c.first_name, c.last_name, c.email
      ORDER BY last_clicked DESC
      LIMIT 500`,
    [silo, url, days],
  );
  respondOk(res, { items: r.rows, url, days });
}));

router.delete("/templates/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  await pool.query("DELETE FROM marketing_template WHERE id = $1 AND silo = $2", [String(req.params.id), silo]);
  respondOk(res, { deleted: true });
}));

// BF_SERVER_TEMPLATE_ANALYTICS_v1 - per-template sends/opens/clicks/replies. Sends/opens/clicks
// from the template_send_events ledger; replies attributed to the last template sent to that
// contact before an inbound message ("last-template-sent" heuristic). Forward-only by design.
router.get("/templates/analytics", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT t.id, t.channel, t.name, t.updated_at,
            COALESCE(s.sends, 0)::int   AS sends,
            COALESCE(s.opens, 0)::int   AS opens,
            COALESCE(s.clicks, 0)::int  AS clicks,
            COALESCE(rp.replies, 0)::int AS replies
       FROM marketing_template t
       LEFT JOIN (
         SELECT template_id,
                count(*)          AS sends,
                count(opened_at)  AS opens,
                count(clicked_at) AS clicks
           FROM template_send_events
          WHERE silo = $1
          GROUP BY template_id
       ) s ON s.template_id = t.id::text
       LEFT JOIN (
         -- BF_SERVER_REPLY_CHANNEL_MATCH_v1 - only count an inbound message as a
         -- reply to a template when the CHANNEL matches: an email template counts
         -- inbound email, an SMS template counts inbound SMS. Without this, an
         -- inbound SMS from a contact whose last template was an email blast was
         -- miscounted as an "email reply" (the phantom "15 replies" bug).
         SELECT tse.template_id, count(*) AS replies
           FROM communications_messages m
           JOIN LATERAL (
             SELECT e.template_id, e.channel
               FROM template_send_events e
              WHERE e.contact_id = m.contact_id::text AND e.sent_at < m.created_at
              ORDER BY e.sent_at DESC
              LIMIT 1
           ) tse ON true
          WHERE m.direction = 'inbound' AND m.silo = $1
            AND m.type = tse.channel
          GROUP BY tse.template_id
       ) rp ON rp.template_id = t.id::text
      WHERE t.silo = $1
      ORDER BY t.updated_at DESC
      LIMIT 200`,
    [silo],
  );
  respondOk(res, { items: r.rows });
}));

// BF_SERVER_SEQUENCE_SEGMENTS_v1 — sequence steps may send email or SMS, so the
// audience includes every contact reachable through either channel. Keep this
// separate from /sms/segments, whose stricter eligibility is correct for blasts.
router.get("/segments", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const reachable = `(COALESCE(c.email,'') <> '' OR COALESCE(c.phone,'') <> '')
                     AND COALESCE(c.marketing_opt_out,false) = false`;
  const tags = await pool.query(
    `SELECT tag, count(*)::int AS n FROM (
       SELECT unnest(c.tags) AS tag FROM contacts c
        WHERE c.silo = $1 AND ${reachable}
     ) t GROUP BY tag ORDER BY n DESC`,
    [silo],
  );
  const total = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM contacts c
      WHERE c.silo = $1 AND ${reachable}`,
    [silo],
  );
  respondOk(res, { all: total.rows[0]?.n ?? 0, segments: tags.rows });
}));

// BF_SERVER_BLOCK_v785_SEQUENCES — drip sequence CRUD + activate/pause.
router.get("/sequences", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const r = await pool.query(
    `SELECT s.id, s.name, s.audience_tag, s.audience_include_tags, s.audience_exclude_tags, s.status, s.stop_on_reply, s.created_at,
            (SELECT count(*)::int FROM marketing_sequence_steps st WHERE st.sequence_id=s.id) AS steps,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id) AS enrolled,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='active') AS active,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='completed') AS completed,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e WHERE e.sequence_id=s.id AND e.status='replied') AS replied,
            -- BF_SERVER_SEQUENCE_TSE_METRICS_v1 - email sends/opens/clicks from the
            -- authoritative template_send_events ledger (same source Template
            -- Performance uses), attributed via the sequence's step templates. The old
            -- sequence-specific ledgers under-counted sends (804 vs 1631 real) and
            -- barely tracked opens (3 vs 456 real).
            (SELECT count(*)::int FROM template_send_events tse
               WHERE tse.channel='email' AND tse.silo=s.silo
                 AND tse.template_id IN (SELECT st.template_id::text FROM marketing_sequence_steps st
                                          WHERE st.sequence_id=s.id AND st.template_id IS NOT NULL)) AS emails_sent,
            (SELECT count(*)::int FROM crm_timeline_events t WHERE t.event_type='sequence_step_sent' AND t.payload->>'sequenceId'=s.id::text AND t.payload->>'channel'='sms') AS sms_sent,
            (SELECT count(*)::int FROM sequence_sends ss WHERE ss.sequence_id=s.id AND ss.channel='sms' AND ss.clicked_at IS NOT NULL) AS sms_clicks,
            (SELECT count(tse.opened_at)::int FROM template_send_events tse
               WHERE tse.channel='email' AND tse.silo=s.silo
                 AND tse.template_id IN (SELECT st.template_id::text FROM marketing_sequence_steps st
                                          WHERE st.sequence_id=s.id AND st.template_id IS NOT NULL)) AS email_opens,
            (SELECT count(tse.clicked_at)::int FROM template_send_events tse
               WHERE tse.channel='email' AND tse.silo=s.silo
                 AND tse.template_id IN (SELECT st.template_id::text FROM marketing_sequence_steps st
                                          WHERE st.sequence_id=s.id AND st.template_id IS NOT NULL)) AS email_clicks,
            (SELECT count(*)::int FROM marketing_sequence_enrollments e JOIN contacts c ON c.id=e.contact_id WHERE e.sequence_id=s.id AND c.marketing_opt_out=true) AS unsubscribed
       FROM marketing_sequences s WHERE s.silo=$1 ORDER BY s.created_at DESC LIMIT 200`,
    [silo]);
  respondOk(res, { items: r.rows });
}));

router.get("/sequences/:id", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const s = await pool.query(`SELECT id, name, audience_tag, audience_include_tags, audience_exclude_tags, status, stop_on_reply, quiet_start, quiet_end FROM marketing_sequences WHERE id=$1 AND silo=$2`, [String(req.params.id), silo]);
  if (s.rowCount === 0) { respondOk(res, { item: null }); return; }
  const steps = await pool.query(`SELECT step_order, channel, wait_minutes, condition, subject, body, html, link_url, template_id, sms_template_id, email_template_id, assignee_user_id, task_type, task_priority, task_queue_id, task_pause FROM marketing_sequence_steps WHERE sequence_id=$1 ORDER BY step_order ASC`, [String(req.params.id)]);
  respondOk(res, { item: s.rows[0], steps: steps.rows });
}));

// BF_SERVER_SEQ_AUTO_TEMPLATES_v1
const uuidOrNull = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-fA-F-]{36}$/.test(v.trim()) ? v.trim() : null;

// BF_SERVER_SEQ_AUDIENCE_TAGS_v1 — normalize API input to unique, non-empty tags.
const tagList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.map((tag) => String(tag).trim()).filter(Boolean))] : [];

router.post("/sequences", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const b = req.body || {};
  const name = String(b.name || "").trim();
  const steps = Array.isArray(b.steps) ? b.steps : [];
  if (!name || steps.length === 0) { respondOk(res, { error: "name and at least one step required" }); return; }
  const seq = await pool.query(
    `INSERT INTO marketing_sequences (silo, name, audience_tag, audience_include_tags, audience_exclude_tags, stop_on_reply, quiet_start, quiet_end, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [silo, name, b.audienceTag ? String(b.audienceTag) : null,
     tagList(b.includeTags ?? b.audienceIncludeTags), tagList(b.excludeTags ?? b.audienceExcludeTags),
     b.stopOnReply !== false, Number(b.quietStart ?? 9), Number(b.quietEnd ?? 21), req.user?.userId ?? null]);
  const seqId = seq.rows[0].id;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i] || {};
    await pool.query(
      // BF_SERVER_SEQ_TASK_STEP_v1 - task-step fields ride along.
      // BF_SERVER_SEQ_AUTO_TEMPLATES_v1 - an auto step carries a template per
      // channel. Accepts camelCase or snake_case so the shared canvas can send
      // either. uuid-guarded so a stray value cannot 500 the whole save on the cast.
      // BF_SERVER_SEQ_STEP_ASSIGNEE_v1 - who a task step is for. uuid-guarded so a
      // stray value cannot 500 the whole save on the cast.
      `INSERT INTO marketing_sequence_steps (sequence_id, step_order, channel, wait_minutes, condition, subject, body, html, link_url, template_id, sms_template_id, email_template_id, assignee_user_id, task_type, task_priority, task_queue_id, task_pause)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [seqId, i, String(st.channel || "email"), Number(st.waitMinutes ?? 0), String(st.condition || "always"), st.subject ?? null, st.body ?? null, st.html ?? null, st.linkUrl ?? null, st.templateId ?? null,
       uuidOrNull(st.smsTemplateId ?? st.sms_template_id), uuidOrNull(st.emailTemplateId ?? st.email_template_id),
       uuidOrNull(st.assigneeUserId ?? st.assignee_user_id),
       st.taskType ?? null, st.taskPriority ?? null, st.taskQueueId ?? null, st.taskPause !== false]);
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

// BF_SERVER_SEQ_ENROLL_CONTACTS_v1 - enroll contacts picked in the CRM list view.
// This intentionally works while paused; activation controls processing, not enrollment.
router.post("/sequences/:id/enroll", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const id = String(req.params.id);
  const owns = await pool.query(`SELECT 1 FROM marketing_sequences WHERE id=$1 AND silo=$2`, [id, silo]);
  if (owns.rowCount === 0) { respondOk(res, { error: "not found" }); return; }
  const raw = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
  const ids = [...new Set(raw.map((value: unknown) => String(value).trim()).filter((value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)))] as string[];
  if (!ids.length) { respondOk(res, { error: "contactIds required" }); return; }
  const enrolled = await enrollContacts(pool, id, ids);
  respondOk(res, { enrolled, requested: ids.length, skipped: ids.length - enrolled });
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

// BF_SERVER_AUTOMATIONS_INVENTORY_v1 - read-only list of every background automation
// ("when X happens -> do Y") currently wired and firing. Source of truth for the
// portal Automations section. Curated from the running workers + event hooks.
router.get("/automations", requireAuth, safeHandler(async (_req: any, res: any) => {
  const items = [
    { id: "product-knowledge", name: "Product knowledge sync", type: "scheduled", cadence: "Every 10 min", trigger: "A lender product is added or changed", action: "Ingest it into Maya's knowledge; prune removed products", status: "active" },
    { id: "marketing-knowledge", name: "Marketing knowledge sync", type: "scheduled", cadence: "Every 10 min", trigger: "A marketing template or collateral file is added", action: "Ingest it into Maya's knowledge", status: "active" },
    { id: "sequence-worker", name: "Drip sequences", type: "scheduled", cadence: "Every 30 sec", trigger: "A contact is enrolled in a sequence and a step is due", action: "Send the next email/SMS step", status: "active" },
    { id: "sms-cascade", name: "SMS-to-email fallback", type: "scheduled", cadence: "36h after send", trigger: "A marketing SMS gets no click and no reply within 36h", action: "Send the fallback marketing email", status: "active" },
    { id: "scheduled-email", name: "Scheduled email send", type: "scheduled", cadence: "When due", trigger: "A drafted email reaches its scheduled send time", action: "Send it via Outlook/Graph", status: "active" },
    { id: "email-followup", name: "Unopened-email nudge", type: "scheduled", cadence: "24 business hrs", trigger: "A staff 1:1 email is not opened within 24 business hours", action: "Notify the sender to follow up", status: "active" },
    { id: "read-receipt", name: "Email open tracking", type: "scheduled", cadence: "Polling", trigger: "A recipient opens a tracked email", action: "Log the open on the contact timeline", status: "active" },
    { id: "mail-reply", name: "Inbound reply capture", type: "scheduled", cadence: "Polling", trigger: "A contact replies by email", action: "File the reply on the timeline (stops their sequence if set)", status: "active" },
    { id: "task-reminders", name: "Task reminders", type: "scheduled", cadence: "When due", trigger: "A task reminder time passes", action: "Send an in-app notification", status: "active" },
    { id: "lender-package", name: "Lender package dispatch", type: "scheduled", cadence: "Job queue", trigger: "An application is finalized for sending", action: "Dispatch the package to the selected lenders", status: "active" },
    { id: "banking-auto", name: "Banking analysis", type: "scheduled", cadence: "When OCR ready", trigger: "Bank-statement documents finish OCR", action: "Run the banking analysis", status: "active" },
    { id: "inbound-attachment", name: "Inbound attachment filing", type: "scheduled", cadence: "Every few min", trigger: "An inbound email has attachments", action: "File them to the matching CRM contact", status: "active" },
    { id: "signnow-poller", name: "SignNow completion", type: "scheduled", cadence: "Polling", trigger: "A SignNow document is signed", action: "Finalize the application", status: "active" },
    { id: "bi-outreach-reply", name: "BI outreach auto-advance", type: "scheduled", cadence: "Polling", trigger: "A BI outreach lead replies", action: "Advance New/Contacted -> Engaged", status: "active" },
    { id: "sendgrid-suppress", name: "CASL suppression", type: "event", cadence: "On event", trigger: "An email bounces, is marked spam, or unsubscribes", action: "Flag the contact opted-out (no more marketing)", status: "active" },
    { id: "stop-on-reply", name: "Stop sequence on reply", type: "event", cadence: "On event", trigger: "A contact replies while in a stop-on-reply sequence", action: "Stop their sequence", status: "active" },
    { id: "signnow-referrer", name: "Referrer activation", type: "event", cadence: "On event", trigger: "A referrer signs their agreement in SignNow", action: "Activate the referrer / attach the signed PNW", status: "active" },
    { id: "product-update-notify", name: "Product update alert", type: "event", cadence: "On event", trigger: "A lender product is updated", action: "Notify staff", status: "active" },
    // BF_SERVER_CONTACT_FORM_AUTOMATION_v1 - surfaced in the live Automations list.
    { id: "contact-form-autoreply", name: "Contact form auto-reply", type: "event", cadence: "On submit", trigger: "Someone submits the website contact form", action: "Tag the contact \"Contact form\" and send the BF-After contact form template email", status: "active" },
  ];
  respondOk(res, { items });
}));

// BF_SERVER_ADS_WAREHOUSE_v1 - locally-owned Google Ads history (survives restarts and
// Google's retention). ?days=90&level=campaign|keyword|search_term. Daily series +
// per-name totals, read from google_ads_daily, not from the Google API.
router.get("/google-ads/history", requireAuth, safeHandler(async (req: any, res: any) => {
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? "90"), 10) || 90, 1), 730);
  const level = ["campaign", "keyword", "search_term"].includes(String(req.query.level)) ? String(req.query.level) : "campaign";
  const series = await pool.query(
    `SELECT stat_date, SUM(cost)::float AS cost, SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks, SUM(conversions)::float AS conversions,
            SUM(conv_value)::float AS conv_value
       FROM google_ads_daily
      WHERE level = $1 AND stat_date >= (CURRENT_DATE - $2::int)
      GROUP BY stat_date ORDER BY stat_date ASC`,
    [level, days],
  );
  const byName = await pool.query(
    `SELECT name, SUM(cost)::float AS cost, SUM(impressions)::bigint AS impressions,
            SUM(clicks)::bigint AS clicks, SUM(conversions)::float AS conversions,
            SUM(conv_value)::float AS conv_value
       FROM google_ads_daily
      WHERE level = $1 AND stat_date >= (CURRENT_DATE - $2::int)
      GROUP BY name ORDER BY cost DESC LIMIT 50`,
    [level, days],
  );
  respondOk(res, { level, days, series: series.rows, byName: byName.rows });
}));

export default router;
