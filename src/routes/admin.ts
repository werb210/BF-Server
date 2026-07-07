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

export default router;
