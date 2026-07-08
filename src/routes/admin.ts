import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { adminRateLimit } from "../middleware/rateLimit.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import auditRoutes from "../modules/audit/audit.routes.js";
import lenderAdminRoutes from "../modules/lender/lender.admin.routes.js";
import ocrAdminRoutes from "../modules/ocr/ocr.admin.routes.js";
import adminOpsRoutes from "./admin.ops.js";
import adminExportsRoutes from "./admin.exports.js";
import adminDashboardRoutes from "./admin.dashboard.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.AUDIT_VIEW]));
router.use(adminRateLimit());
router.use("/audit", auditRoutes);
router.use("/ops", adminOpsRoutes);
router.use("/exports", adminExportsRoutes);
router.use("/ocr", ocrAdminRoutes);
router.use("/", adminDashboardRoutes);
// BF_SERVER_BLOCK_v221_ADMIN_USERS_LIST_v1
// Staff list for the calendar attendee picker and other admin surfaces.
// Excludes soft-deleted users. Active users only.
router.get("/users", requireCapability([CAPABILITIES.USER_MANAGE]), async (_req: any, res: any) => {
  try {
    const r = await (await import("../db.js")).pool.query<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: string | null;
      is_active: boolean;
    }>(
      `SELECT id, first_name, last_name, email, role, is_active
         FROM users
        WHERE COALESCE(is_active, true) = true
          AND deleted_at IS NULL
        ORDER BY COALESCE(NULLIF(TRIM(first_name), ''), email, id::text) ASC
        LIMIT 500`
    );
    const users = r.rows.map((u) => ({
      id: u.id,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      role: u.role,
      // Provide a pre-composed name field for clients that don't want
      // to recompose first+last; CalendarPage.tsx uses `name` first.
      name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (u.email ?? ""),
    }));
    return res.json({ users });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[admin users list] failed", message);
    return res.status(500).json({ error: "users_list_failed" });
  }
});
router.get("/users/:id", requireCapability([CAPABILITIES.USER_MANAGE]), async (req: any, res: any) => {
  const { rows } = await (await import("../db.js")).pool.query(`SELECT id, email, role, silo, outbound_caller_id FROM users WHERE id = $1 LIMIT 1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  return res.status(200).json(rows[0]);
});

router.patch("/users/:id", requireCapability([CAPABILITIES.USER_MANAGE]), async (req: any, res: any) => {
  const value = req.body?.outbound_caller_id;
  if (!(value === null || (typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value)))) return res.status(400).json({ error: "invalid_outbound_caller_id" });
  const { rows } = await (await import("../db.js")).pool.query(`UPDATE users SET outbound_caller_id = $1 WHERE id = $2 RETURNING id, email, role, silo, outbound_caller_id`, [value, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  return res.status(200).json(rows[0]);
});

router.use("/", lenderAdminRoutes);

// BF_SERVER_BLOCK_vA_REINGEST_PRODUCTS_v1 — rebuild Maya's product knowledge.
// embedAndStore APPENDS (no replace), so we DELETE the prior product rows first
// to avoid duplicate embeddings, then re-ingest all lender_products. Trigger
// once after a product seed. Admin-gated (USER_MANAGE), like sibling /users.
router.post(
  "/reingest-products",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const { ingestAllProducts } = await import("../modules/ai/productIngest.service.js");
      const del = await pool.query(
        "DELETE FROM ai_knowledge WHERE source_type = 'product' OR source_type LIKE 'product:%'",
      );
      await ingestAllProducts(pool);
      const cnt = await pool.query("SELECT count(*)::int AS n FROM lender_products");
      res.json({ ok: true, deleted: del.rowCount ?? 0, ingested: cnt.rows[0]?.n ?? 0 });
    } catch (e: any) {
      console.error("reingest_products_failed", { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message ?? "reingest_failed" });
    }
  },
);

// One-shot finalize for an application already signed in SignNow whose signed
// event never reached us (embedded signing has no read-back; webhook may not
// have been registered yet). Stamps signnow_app_signed_at, purges SSN/SIN, logs
// the CRM event, and enqueues the lender package. Idempotent: finalize no-ops if
// already signed. Admin-gated (USER_MANAGE), like sibling admin routes.
router.post(
  "/applications/:id/mark-signed",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const id = String(req.params.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "missing id" });
      const { pool } = await import("../db.js");
      const { finalizeSignedApplication } = await import(
        "../signnow/finalizeSignedApplication.js"
      );
      const row = await pool.query<{ contact_id: string | null }>(
        "SELECT contact_id FROM applications WHERE id::text = $1::text LIMIT 1",
        [id],
      );
      if (row.rows.length === 0)
        return res.status(404).json({ ok: false, error: "application not found" });
      const fired = await finalizeSignedApplication(
        { id, contactId: row.rows[0]?.contact_id ?? null },
        { documentId: null },
      );
      // Safety net: if the lender package already went out on an earlier run
      // (worker dispatched before the pipeline-advance fix), advance the card now.
      // Gated on an existing 'sent' package row, so it never moves prematurely and
      // never re-dispatches. The fresh path advances via the worker after dispatch.
      await pool.query(
        `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now()
           WHERE id::text = ($1)::text
             AND pipeline_state NOT IN ('Off to Lender','Offer','Accepted','Rejected','Declined','Funded','Closed')
             AND EXISTS (SELECT 1 FROM application_packages p
                          WHERE p.application_id::text = ($1)::text AND p.status = 'sent')`,
        [id],
      );
      res.json({
        ok: true,
        finalized: fired,
        note: fired ? "lender package enqueued" : "already finalized",
      });
    } catch (e: any) {
      console.error("mark_signed_failed", { message: e?.message });
      res.status(500).json({ ok: false, error: e?.message ?? "mark_signed_failed" });
    }
  },
);

// BF_SERVER_SIGNNOW_SELFTEST_RESET_v1 - diagnose the SignNow fieldextract 65656 with the REAL
// key by uploading a minimal, known-valid-tag PDF. If this succeeds, the 65656 is specific to the
// application PDF; if it fails the same way, the problem is account/plan/auth level. Admin-only.
router.post(
  "/signnow-fieldextract-selftest",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const signnow = await import("../signnow/signnowClient.js");
      // v_SIGNNOW_DROP_DATE_TAG: fieldextract is all-or-nothing, so probe each date-tag
      // candidate in its OWN PDF (each paired with a known-good signature tag). Whichever
      // returns ok is the date syntax SignNow accepts here -> put that exact tag in the builders.
      const candidates: { id: string; dateTag: string }[] = [
        { id: "signature only (control - must pass)", dateTag: "" },
        { id: 't:t with l:"Date"', dateTag: '{{t:t;r:y;o:"Owner 1";l:"Date";w:90;h:16;}}' },
        { id: 't:d with l:"Date"', dateTag: '{{t:d;r:y;o:"Owner 1";l:"Date";w:90;h:16;}}' },
        { id: 't:d bare (the tag that broke signing)', dateTag: '{{t:d;r:y;o:"Owner 1";w:90;h:16;}}' },
      ];
      const results: any[] = [];
      for (const c of candidates) {
        const doc = await PDFDocument.create();
        const page = doc.addPage([612, 792]);
        const font = await doc.embedFont(StandardFonts.Helvetica);
        page.drawText("SignNow fieldextract self-test", { x: 40, y: 740, size: 12, font, color: rgb(0, 0, 0) });
        page.drawText('{{t:s;r:y;o:"Owner 1";w:140;h:16;}}', { x: 40, y: 700, size: 6, font, color: rgb(1, 1, 1) });
        if (c.dateTag) page.drawText(c.dateTag, { x: 240, y: 700, size: 6, font, color: rgb(1, 1, 1) });
        const bytes = await doc.save();
        try {
          const r = await signnow.uploadDocumentWithFieldExtract(bytes, "fieldextract-selftest.pdf");
          results.push({ candidate: c.id, dateTag: c.dateTag || null, ok: true, documentId: r.documentId });
        } catch (e: any) {
          results.push({ candidate: c.id, dateTag: c.dateTag || null, ok: false, status: e?.status ?? null, body: e?.body ?? null, message: e instanceof Error ? e.message : String(e) });
        }
      }
      const working = results.filter((r) => r.ok && r.dateTag).map((r) => r.dateTag);
      return res.json({
        ok: results.some((r) => r.ok),
        results,
        verdict: working.length
          ? "Date-tag syntax that PASSED fieldextract (use this in the PDF builders): " + working.join(" | ")
          : "No date-tag candidate passed; only signature-only works on this account.",
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_SIGNNOW_SELFTEST_RESET_v1 - clear a wedged signing session so the next "Send for
// signing" mints a fresh one. Local-only (does not cancel the SignNow-side group; the session
// logic already regenerates orphaned groups). Refuses to touch an already-signed application.
router.post(
  "/applications/:id/reset-signing",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const id = String(req.params.id || "");
      if (!id) return res.status(400).json({ ok: false, error: "missing id" });
      const { pool } = await import("../db.js");
      const upd = await pool.query<{ id: string }>(
        `UPDATE applications
            SET signnow_document_id = NULL,
                submission_chain_started_at = NULL,
                metadata = (COALESCE(metadata, '{}'::jsonb) - 'signnow_embedded'),
                updated_at = now()
          WHERE id::text = ($1)::text
            AND signnow_app_signed_at IS NULL
          RETURNING id`,
        [id],
      );
      if (upd.rows.length === 0) {
        return res.status(409).json({ ok: false, error: "already_signed_or_not_found" });
      }
      return res.json({ ok: true, id });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// v_SIGNNOW_REALPDF_SELFTEST_v1 - run the REAL signing PDFs (same buildApplicationPdf +
// buildAccordPdf the live flow uses) through fieldextract, and dump every {{...}} token found
// in each PDF's extractable text layer so we can see exactly which doc/tag SignNow chokes on.
router.post(
  "/applications/:id/signing-pdf-selftest",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ ok: false, error: "missing application id" });
    try {
      const { loadApplicationForPdf } = await import("../signnow/sendApplicationForSignature.js");
      const { buildApplicationPdf } = await import("../signnow/pdfBuilder.js");
      const { buildAccordPdf } = await import("../signnow/accordPdfBuilder.js");
      const signnow = await import("../signnow/signnowClient.js");
      const pdfParseMod: any = await import("pdf-parse");
      const pdfParse: any = pdfParseMod.default || pdfParseMod;

      const docs: any[] = [];
      const run = async (label: string, build: () => Promise<Uint8Array>) => {
        let bytes: Uint8Array;
        try {
          bytes = await build();
        } catch (e: any) {
          docs.push({ doc: label, ok: false, stage: "build", error: e instanceof Error ? e.message : String(e) });
          return;
        }
        const buf = Buffer.from(bytes);
        let tags: string[] = [];
        let textError: string | null = null;
        try {
          const parsed: any = await pdfParse(buf);
          const text: string = String((parsed && parsed.text) || "");
          tags = (text.match(/\{\{[\s\S]{0,90}/g) || []).map((t: string) => t.replace(/\s+/g, " ").trim());
        } catch (e: any) {
          textError = e instanceof Error ? e.message : String(e);
        }
        let pdfUrl: string | null = null;
        try {
          const { getStorage } = await import("../lib/storage/index.js");
          const up = await getStorage().put({ buffer: buf, filename: `signing-selftest-${label}-${id}.pdf`, contentType: "application/pdf", pathPrefix: `diag/${id}` });
          pdfUrl = up.url;
        } catch {
          /* non-fatal */
        }
        try {
          const r = await signnow.uploadDocumentWithFieldExtract(bytes, `selftest-${label}.pdf`);
          docs.push({ doc: label, ok: true, sizeBytes: buf.length, tagCount: tags.length, extractedTags: tags, textError, pdfUrl, documentId: r.documentId });
        } catch (e: any) {
          docs.push({ doc: label, ok: false, stage: "fieldextract", status: e?.status ?? null, body: e?.body ?? null, message: e instanceof Error ? e.message : String(e), sizeBytes: buf.length, tagCount: tags.length, extractedTags: tags, textError, pdfUrl });
        }
      };

      const inputs = await loadApplicationForPdf(id);
      await run("boreal", () => buildApplicationPdf(inputs));
      await run("accord", () => buildAccordPdf(id));

      const boreal = docs.find((d) => d.doc === "boreal");
      const accord = docs.find((d) => d.doc === "accord");
      const borealOk = !!(boreal && boreal.ok);
      const accordFieldFail = !!(accord && accord.stage === "fieldextract" && !accord.ok);
      return res.json({
        ok: borealOk,
        applicationId: id,
        docs,
        verdict: borealOk
          ? (accordFieldFail
              ? "Boreal form PASSES fieldextract (signing works); the Accord form fails and is auto-skipped. See the accord doc extractedTags/body."
              : "Both signing PDFs pass fieldextract; signing should work for this application.")
          : "BOREAL form FAILS fieldextract -- this is what 65656s the real signing. Inspect its extractedTags for a malformed {{...}} tag (or open pdfUrl).",
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_SENDGRID_DIAGNOSTICS_v1 - "test SendGrid now". Reports whether the
// key + from are set, and (if a `to` is given) does a real single send and
// returns SendGrid's EXACT status + error body. This turns a silent failure
// (the email tab / sequences going nowhere) into an immediate, legible answer:
// 401 => bad/rotated API key; 403 with a "from"/"sender" message => the
// SENDGRID_FROM address (info@boreal.financial) is not a verified sender or its
// domain authentication lapsed. Admin-guarded (requireAuth + AUDIT_VIEW above).
router.post(
  "/sendgrid-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { sendgridConfigured, sendOne } = await import("../services/sendgridService.js");
      const keySet = Boolean(process.env.SENDGRID_API_KEY);
      const fromSet = Boolean(process.env.SENDGRID_FROM);
      const from = process.env.SENDGRID_FROM ? String(process.env.SENDGRID_FROM) : null;
      const keyPrefix = process.env.SENDGRID_API_KEY ? String(process.env.SENDGRID_API_KEY).slice(0, 3) : null;
      const base = { configured: sendgridConfigured(), keySet, fromSet, from, keyPrefix, keyLooksValid: keyPrefix === "SG." };

      const to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
      if (!to) {
        return res.json({ ...base, tested: false, hint: "POST { to } to run a live test send and see SendGrid's exact response." });
      }
      if (!sendgridConfigured()) {
        return res.json({ ...base, tested: false, error: "not_configured", hint: "SENDGRID_API_KEY and/or SENDGRID_FROM is missing." });
      }
      const r = await sendOne({
        to,
        subject: "Boreal SendGrid diagnostics",
        html: "<p>This is a Boreal SendGrid diagnostics test send. If you received this, sending works.</p>",
      });
      // Interpret the common failure codes so the operator gets a plain answer.
      let diagnosis = "ok";
      if (!r.ok) {
        if (r.status === 401) diagnosis = "api_key_invalid";
        else if (r.status === 403) diagnosis = "sender_not_verified_or_forbidden";
        else diagnosis = `sendgrid_error_${r.status}`;
      }
      return res.json({ ...base, tested: true, sendStatus: r.status, ok: r.ok, diagnosis, error: r.error ?? null });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_GOOGLE_ADS_DIAGNOSTICS_v1 - "test Google Ads now". Reports which of
// the five credentials are set and, when all are present, does a live token
// exchange + trivial API call, returning a plain diagnosis (e.g.
// developer_token_not_approved_for_production, refresh_token_or_oauth_client_invalid,
// customer_id_not_found_or_not_linked, ok). Never returns secrets. Admin-guarded.
router.post(
  "/google-ads-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { googleAdsDiagnostics } = await import("../services/googleAdsService.js");
      const out = await googleAdsDiagnostics();
      return res.json(out);
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_AD_ATTRIBUTION_BACKFILL_v1 - re-resolve gclids captured while Google Ads
// creds were down. Finds contacts with an 'attribution' timeline event carrying a
// gclid but no contact_ad_attribution row, and resolves each via the Google Ads API.
// Google's click_view only reaches back ~90 days, so older clicks may not resolve.
// Admin-guarded. Returns candidate count and how many actually resolved.
router.post(
  "/backfill-ad-attribution",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { googleAdsConfigured } = await import("../services/googleAdsService.js");
      if (!googleAdsConfigured()) return res.json({ ok: false, error: "google_ads_not_configured" });
      const { resolveAndStoreAdAttribution } = await import("../services/googleAdsAttribution.js");
      const { pool } = await import("../db.js");
      const rows = (await pool.query<{ contact_id: string; gclid: string; captured_at: string | null }>(
        `SELECT DISTINCT ON (e.contact_id::text)
                e.contact_id::text AS contact_id,
                e.payload->>'gclid' AS gclid,
                e.payload->>'capturedAt' AS captured_at
           FROM crm_timeline_events e
          WHERE e.event_type = 'attribution'
            AND COALESCE(e.payload->>'gclid','') <> ''
            AND NOT EXISTS (
              SELECT 1 FROM contact_ad_attribution a WHERE a.contact_id::text = e.contact_id::text
            )
          ORDER BY e.contact_id::text, e.created_at DESC
          LIMIT 1000`,
      )).rows;
      const ids = rows.map((r) => r.contact_id);
      for (const r of rows) {
        try { await resolveAndStoreAdAttribution({ contactId: r.contact_id, gclid: r.gclid, occurredAt: r.captured_at }); } catch { /* skip */ }
      }
      const resolved = ids.length
        ? Number((await pool.query<{ n: number }>(
            `SELECT count(DISTINCT contact_id)::int AS n FROM contact_ad_attribution WHERE contact_id::text = ANY($1)`,
            [ids],
          )).rows[0]?.n ?? 0)
        : 0;
      return res.json({ ok: true, candidates: rows.length, resolved, note: "Clicks older than ~90 days may not resolve (Google limit)." });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_AD_ATTRIBUTION_DIAG_v1 - settles "why is Marketing Source empty" by
// counting where gclids exist across the funnel. Apps-with-gclid but no contact
// events => mirror not propagating; no apps-with-gclid => the site isn't capturing
// gclid (or no ad-clicker has applied yet). Admin-guarded, counts only.
router.post(
  "/ad-attribution-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (_req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const { googleAdsConfigured } = await import("../services/googleAdsService.js");
      const { conversionsConfigured } = await import("../services/googleAdsConversions.js");
      const applicationsWithGclid = Number((await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM applications WHERE COALESCE(metadata->'attribution'->>'gclid','') <> ''`,
      )).rows[0]?.n ?? 0);
      const contactsWithGclidEvent = Number((await pool.query<{ n: number }>(
        `SELECT count(DISTINCT contact_id)::int AS n FROM crm_timeline_events WHERE event_type='attribution' AND COALESCE(payload->>'gclid','') <> ''`,
      )).rows[0]?.n ?? 0);
      const contactsResolved = Number((await pool.query<{ n: number }>(
        `SELECT count(DISTINCT contact_id)::int AS n FROM contact_ad_attribution`,
      )).rows[0]?.n ?? 0);
      let diagnosis = "no_gclids_captured_yet_or_no_ad_clicker_applied";
      if (applicationsWithGclid > 0 && contactsWithGclidEvent === 0) diagnosis = "captured_on_applications_but_not_propagated_to_contacts";
      else if (contactsWithGclidEvent > 0 && contactsResolved === 0) diagnosis = "captured_on_contacts_but_none_resolved_check_google_ads_creds_or_90day_window";
      else if (contactsResolved > 0) diagnosis = "working";
      return res.json({ ok: true, googleAdsConfigured: googleAdsConfigured(), conversionsConfigured: conversionsConfigured(), applicationsWithGclid, contactsWithGclidEvent, contactsResolved, diagnosis });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_REFERRER_AGREEMENT_DIAG_v1 - verify the SignNow referrer-agreement config
// without running a real signup. Reports which env vars are set, whether the API key
// actually authenticates, and (when probe=true) whether the template id resolves by
// creating a throwaway document from it. Never returns secrets. Admin-guarded.
router.post(
  "/referrer-agreement-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    const apiKeySet = Boolean((process.env.SIGNNOW_API_KEY ?? "").trim());
    const templateId = (process.env.SIGNNOW_REFERRER_TEMPLATE_ID ?? "").trim();
    const roleName = (process.env.SIGNNOW_REFERRER_ROLE_NAME ?? "Referrer").trim();
    const out: Record<string, unknown> = {
      apiKeySet,
      templateIdSet: templateId.length > 0,
      roleName,
      configured: apiKeySet && templateId.length > 0,
    };
    if (!apiKeySet) {
      out.diagnosis = "signnow_api_key_missing";
      return res.json(out);
    }
    try {
      const { getAuthenticatedUserId } = await import("../signnow/signnowClient.js");
      await getAuthenticatedUserId();
      out.apiKeyValid = true;
    } catch (e: any) {
      out.apiKeyValid = false;
      out.diagnosis = "signnow_api_key_invalid_or_expired";
      out.error = e instanceof Error ? e.message : String(e);
      return res.json(out);
    }
    if (!templateId) {
      out.diagnosis = "template_id_missing_set_SIGNNOW_REFERRER_TEMPLATE_ID";
      return res.json(out);
    }
    if (req.body?.probe === true) {
      try {
        const { createDocumentFromTemplate } = await import("../signnow/signnowClient.js");
        const { documentId } = await createDocumentFromTemplate(templateId, "Boreal referrer-agreement diagnostics probe");
        out.templateResolves = true;
        out.probeDocumentId = documentId;
        out.diagnosis = "ok";
        out.note = "A throwaway document was created from the template; delete it in SignNow if you wish.";
      } catch (e: any) {
        out.templateResolves = false;
        out.diagnosis = "template_id_not_found_or_not_a_template";
        out.error = e instanceof Error ? e.message : String(e);
      }
      return res.json(out);
    }
    out.diagnosis = "configured_send_probe_true_to_verify_template";
    return res.json(out);
  },
);

// BF_SERVER_REFERRER_TEMPLATE_GEN_v1 - generate the SignNow referrer-agreement TEMPLATE
// from code instead of building it by hand in the SignNow dashboard. Builds the agreement
// PDF with field-extract text tags (role "Referrer"), uploads it via /document/fieldextract
// so SignNow parses the tags into real fields, then promotes the document to a template.
// Returns the template id to put in SIGNNOW_REFERRER_TEMPLATE_ID. Admin-guarded.
router.post(
  "/generate-referrer-template",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { isApiKeyConfigured, uploadDocumentWithFieldExtract, createTemplateFromDocument } = await import("../signnow/signnowClient.js");
      if (!isApiKeyConfigured()) return res.status(400).json({ ok: false, error: "signnow_api_key_missing" });
      const { buildReferrerAgreementPdf } = await import("../signnow/referrerAgreementPdfBuilder.js");
      const pdf = await buildReferrerAgreementPdf();
      if (req.body?.pdfOnly === true) {
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", 'inline; filename="boreal-referral-partner-agreement.pdf"');
        return res.end(Buffer.from(pdf));
      }
      const name = typeof req.body?.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : "Boreal Referral Partner Agreement";
      const { documentId } = await uploadDocumentWithFieldExtract(pdf, `${name}.pdf`);
      const { templateId } = await createTemplateFromDocument(documentId, name);
      const roleName = (process.env.SIGNNOW_REFERRER_ROLE_NAME ?? "Referrer").trim();
      return res.json({
        ok: true,
        templateId,
        documentId,
        roleName,
        next: `Set SIGNNOW_REFERRER_TEMPLATE_ID=${templateId} on boreal-staff-server (tick "Deployment slot setting"), then re-run referrer-agreement-diagnostics with probe:true.`,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_SEND_JOB_DIAG_v1 - read recent marketing send jobs. Answers "why did only N of M
// go out": status='done' with a large `failed` means SendGrid rejected them (see `error`);
// status='running' long after started_at means the process died mid-blast and (before the
// reclaim shipped) nothing resumed it - those recipients were never attempted. Admin-guarded.
router.post(
  "/send-job-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const limit = Math.min(Math.max(parseInt(String(req.body?.limit ?? "10"), 10) || 10, 1), 50);
      const rows = (await pool.query(
        `SELECT id::text, channel, silo, tag, status, total, sent, failed, error,
                created_at, started_at, finished_at, updated_at,
                (total - sent - failed) AS never_attempted,
                EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::int AS run_seconds
           FROM marketing_send_jobs
          ORDER BY created_at DESC
          LIMIT $1`,
        [limit],
      )).rows;
      const jobs = rows.map((r: any) => {
        let diagnosis = "ok";
        if (r.status === "running" && r.started_at) diagnosis = "stalled_mid_blast_recipients_never_attempted";
        else if (r.status === "failed") diagnosis = "job_threw_see_error";
        else if (r.status === "done" && Number(r.failed) > 0) diagnosis = "sendgrid_rejected_some_see_error";
        else if (Number(r.never_attempted) > 0) diagnosis = "counts_do_not_add_up_recipients_unaccounted";
        return { ...r, diagnosis };
      });
      return res.json({ ok: true, jobs });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_EMAIL_FORENSICS_v1 - reconstruct exactly what a past email blast did from the
// per-contact audit trail (crm_timeline_events, event_type='email_marketing_sent'), which is
// written once per successful send. Answers "how many actually went out on day X, to whom,
// under what subject" from the source of truth rather than from job counters. Admin-guarded.
router.post(
  "/email-forensics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const day = typeof req.body?.day === "string" && req.body.day.trim() ? req.body.day.trim() : null; // 'YYYY-MM-DD'

      const bySubject = (await pool.query(
        `SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
                COALESCE(payload->>'subject','(none)') AS subject,
                COUNT(*)::int AS sent,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
           FROM crm_timeline_events
          WHERE event_type = 'email_marketing_sent'
            ${day ? "AND (created_at AT TIME ZONE 'UTC')::date = $1::date" : ""}
          GROUP BY 1,2
          ORDER BY day DESC, sent DESC
          LIMIT 50`,
        day ? [day] : [],
      )).rows;

      const totals = (await pool.query(
        `SELECT COUNT(*)::int AS total_contacts,
                COUNT(*) FILTER (WHERE email IS NOT NULL AND email <> '')::int AS with_email
           FROM contacts`,
      )).rows[0];

      let missed: any = undefined;
      if (day) {
        missed = (await pool.query(
          `SELECT COUNT(*)::int AS missed_with_email
             FROM contacts c
            WHERE c.email IS NOT NULL AND c.email <> ''
              AND NOT EXISTS (
                SELECT 1 FROM crm_timeline_events e
                 WHERE e.contact_id = c.id
                   AND e.event_type = 'email_marketing_sent'
                   AND (e.created_at AT TIME ZONE 'UTC')::date = $1::date
              )`,
          [day],
        )).rows[0];
      }

      return res.json({ ok: true, day, totals, missed, bySubject });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_BLAST_AUDIENCE_DIAG_v1 - show exactly who a marketing email blast would target,
// broken down by silo, so a "sent to nobody / only N" blast is explained by data. The blast
// route counts contacts WHERE silo = resolveSiloFromRequest(req) AND email present AND NOT
// opted out AND tag matches - if that resolves to the wrong silo, the count is 0 or partial
// and the route silently succeeds with zero recipients. Admin-guarded.
router.post(
  "/blast-audience-diagnostics",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const tag = typeof req.body?.tag === "string" && req.body.tag.trim() ? req.body.tag.trim() : null;

      const perSilo = (await pool.query(
        `SELECT COALESCE(silo,'(null)') AS silo,
                COUNT(*)::int AS contacts,
                COUNT(*) FILTER (WHERE COALESCE(email,'') <> '')::int AS with_email,
                COUNT(*) FILTER (WHERE COALESCE(email,'') <> '' AND COALESCE(marketing_opt_out,false) = false)::int AS emailable,
                COUNT(*) FILTER (WHERE COALESCE(email,'') <> '' AND COALESCE(marketing_opt_out,false) = false
                                 AND ($1::text IS NULL OR $1 = ANY(tags)))::int AS emailable_with_tag
           FROM contacts
          GROUP BY 1
          ORDER BY emailable DESC`,
        [tag],
      )).rows;

      const grand = perSilo.reduce((a: any, r: any) => ({
        contacts: a.contacts + r.contacts,
        with_email: a.with_email + r.with_email,
        emailable: a.emailable + r.emailable,
        emailable_with_tag: a.emailable_with_tag + r.emailable_with_tag,
      }), { contacts: 0, with_email: 0, emailable: 0, emailable_with_tag: 0 });

      const role = String(req.user?.role || "").toLowerCase();
      const primary = req.user?.silo ?? "BF";
      const allowlist = Array.isArray(req.user?.silos) ? req.user.silos : [];
      const requested = (req.headers["x-silo"] || (req.query?.silo)) ?? null;
      let resolvedSilo = primary;
      if (role === "admin") resolvedSilo = requested || primary;
      else if (allowlist.length > 1 && requested && allowlist.includes(requested)) resolvedSilo = requested;

      return res.json({
        ok: true,
        tag,
        yourUser: { role, primarySilo: primary, allowlist, requestedSilo: requested, resolvedSilo },
        note: "A blast from this session targets 'emailable' (or 'emailable_with_tag') for silo = resolvedSilo. If that number is 0 or ~800 when you expected more, either the wrong silo resolved or your list lives in another silo.",
        grandTotal: grand,
        perSilo,
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

// BF_SERVER_SEND_BREAKDOWN_v1 - count EVERY send-event type per day from crm_timeline_events,
// so a day's activity is attributed to the exact path that produced it: email_marketing_sent
// (the blast) vs sequence_step_sent (the drip sequence). Answers "what actually sent on day X
// and through which system" from the per-contact audit trail. Admin-guarded.
router.post(
  "/send-breakdown",
  requireCapability([CAPABILITIES.USER_MANAGE]),
  async (req: any, res: any) => {
    try {
      const { pool } = await import("../db.js");
      const day = typeof req.body?.day === "string" && req.body.day.trim() ? req.body.day.trim() : null;
      const rows = (await pool.query(
        `SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
                event_type,
                COUNT(*)::int AS n,
                COUNT(DISTINCT contact_id)::int AS distinct_contacts,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
           FROM crm_timeline_events
          WHERE event_type IN ('email_marketing_sent','sequence_step_sent')
            ${day ? "AND (created_at AT TIME ZONE 'UTC')::date = $1::date" : "AND created_at > now() - interval '30 days'"}
          GROUP BY 1,2
          ORDER BY day DESC, n DESC`,
        day ? [day] : [],
      )).rows;
      return res.json({ ok: true, day, breakdown: rows });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
);

export default router;
