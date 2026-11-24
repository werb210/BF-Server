import { Router } from "express";
import fs from "node:fs"; // BF_SERVER_v903_YE26_TEMPLATES
import path from "node:path"; // BF_SERVER_v903_YE26_TEMPLATES
import { randomUUID } from "node:crypto"; // BF_SERVER_v791_LEAD_SCHEMA
import { dbQuery } from "../db.js";
import { requireFields } from "../middleware/validate.js";
import { LeadSchema } from "../validation.js";
import { fail, ok } from "../lib/apiResponse.js";
import { wrap } from "../lib/routeWrap.js";
import { stripUndefined } from "../utils/clean.js";
import { getLandingBySlug } from "../services/landingPage.service.js"; // BF_SERVER_BLOCK_v780_PUBLIC_LANDING_IMPORT
import { getStorage } from "../lib/storage/index.js"; // BF_SERVER_BLOCK_v456_LENDER_PACKAGE_LINK
import rateLimit from "express-rate-limit";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { CONVERSATION_TOKEN_HEADER, verifyConversationToken } from "../services/publicConversationTokens.js"; // BF_SERVER_v789_CONVERSATION_TOKENS
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js"; // BF_SERVER_v789_CASL_EXPRESS_CONSENT
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js"; // BF_SERVER_v789_SILENT_QUERIES

const router = Router();

// BF_EMAIL_LOGO_ROUTE_v1 - public Boreal email logo (PNG), no auth, immutable cache.
// BF_EMAIL_LOGO_REAL_v1 - real Boreal Financial landscape logo (white mountain mark +
// "Boreal Financial" wordmark on brand blue #1E3A8A), 600x150 optimized PNG.
// Replaces the prior mangled 2-color placeholder.
// BF_EMAIL_LOGO_CRISP_v1 (2026-11-24) - the wordmark had been drawn in a pixel font; now rendered in Inter at 1320x459.
const EMAIL_LOGO_PNG_B64 = "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";
router.get("/email/logo.png", (_req, res) => {
  const buf = Buffer.from(EMAIL_LOGO_PNG_B64, "base64");
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  // BF_EMAIL_LOGO_CORP_v1 - override Helmet default CORP (same-origin) so the logo
  // can be embedded cross-origin in the portal email preview iframe.
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(buf);
});

// BF_SERVER_v903_YE26_TEMPLATES - header images for the year-end 2026 email templates. Public (they are in sent
// emails), filename-whitelisted so nothing else in assets/ can be read.
// BF_SERVER_v905_APP_LAUNCH - also the app launch campaign's images.
router.get("/email/:campaign(ye26|applaunch)/:file", (req, res) => {
  const campaign = String(req.params.campaign ?? "");
  const file = String(req.params.file ?? "");
  if (!["ye26", "applaunch"].includes(campaign) || !/^[a-z0-9-]+\.jpg$/.test(file)) { res.status(404).end(); return; }
  const full = path.join(process.cwd(), "assets", "email", campaign, file);
  if (!fs.existsSync(full)) { res.status(404).end(); return; }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.end(fs.readFileSync(full));
});

// BF_SERVER_BLOCK_v456_LENDER_PACKAGE_LINK - private, expiring package download.
router.get("/lender-package/:token", async (req, res) => {
  const token = String(req.params.token ?? "");
  res.setHeader("Cache-Control", "no-store");
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).type("text/plain").send("Package not found.");
  try {
    const found = await dbQuery<{ blob_name: string; filename: string; expires_at: string }>(
      `SELECT blob_name, filename, expires_at FROM lender_package_links WHERE token = $1 LIMIT 1`, [token],
    );
    const row = found.rows[0];
    if (!row) return res.status(404).type("text/plain").send("Package not found.");
    if (new Date(row.expires_at).getTime() < Date.now()) return res.status(410).type("text/plain").send("This download link has expired. Reply to the email from Boreal Financial and we will resend it.");
    const file = await getStorage().get(row.blob_name);
    if (!file) return res.status(404).type("text/plain").send("Package not found.");
    await dbQuery(`UPDATE lender_package_links SET download_count = download_count + 1, last_downloaded_at = now() WHERE token = $1`, [token]).catch((err) => {
      console.warn("[lender-package] download count failed", { message: err instanceof Error ? err.message : String(err) });
      return { rows: [] };
    });
    const safeName = String(row.filename).replace(/[^A-Za-z0-9._-]/g, "_");
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Content-Length", String(file.buffer.length));
    return res.end(file.buffer);
  } catch (err) {
    console.warn("[lender-package] download failed", { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).type("text/plain").send("The package could not be loaded. Please try again shortly.");
  }
});

// BF_SERVER_BLOCK_v780_PUBLIC_LANDING — hosted email page; bf-website /e/:slug
// fetches this. Public + permissive CORS so boreal.finance can read it.
router.get("/landing/:slug", async (req, res) => {
  try {
    const page = await getLandingBySlug(String(req.params.slug));
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!page) return res.status(404).json({ ok: false, error: "not_found" });
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.json({ ok: true, title: page.title, html: page.html });
  } catch {
    return res.status(500).json({ ok: false, error: "landing_failed" });
  }
});


type LeadPayload = Record<string, unknown>;

// BF_SERVER_v791_LEAD_SCHEMA - companyName is the required company field (the
// route's requireFields demands it and the schema now accepts it).
async function createLead(payload: LeadPayload): Promise<{ leadId?: string }> {
  // BF_SERVER_v789_CASL_EXPRESS_CONSENT - the consent fields are recorded by the
  // route, not part of the (strict) lead schema.
  const { casl_consent: _c, casl_consent_text: _t, casl_consent_at: _a, sms_consent: _s, email_consent: _e, ...leadFields } = (payload ?? {}) as Record<string, unknown>; // v931: the two boxes too

  const parsed = LeadSchema.safeParse(leadFields);

  if (!parsed.success) {
    return {};
  }

  const data = parsed.data;
  const fullName = (data.fullName || [data.firstName, data.lastName].filter(Boolean).join(" ")).trim() || null;
  const requestedAmount = data.requestedAmount === undefined || data.requestedAmount === null || data.requestedAmount === ""
    ? null
    : String(data.requestedAmount);
  // crm_leads.id has no column default - supply it, as every other insert does.
  const result = await dbQuery<{ id: string }>(
    `insert into crm_leads (id, email, phone, company_name, product_interest, requested_amount, full_name, notes, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'public_api')
       returning id`,
    [randomUUID(), data.email, data.phone || null, data.companyName, data.productType || null, requestedAmount, fullName, data.message || null],
  );

  return stripUndefined({ leadId: result.rows[0]?.id });
}

// BF_SERVER_v68_LEAD_RES_JSON - every branch must explicitly call
// res.status(N).json(envelope). `wrap()` only catches errors; `ok`/`fail`
// only build envelope objects. Without an explicit res.json the response
// is never sent and the client hangs until timeout.
// BF_SERVER_WIZARD_BLOCK_v153
// Records a wizard hard stop at the moment it happens, because the answers that
// caused it are otherwise never sent: saveStepData writes to localStorage only,
// and startApplication runs after the block returns.
//
// Unauthenticated by necessity - the applicant has not identified themselves at
// this point. Everything written is either supplied by the client or a lookup on
// what it supplied, and the unique index keeps a repeated selection to one row.
router.post(
  "/wizard-block",
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const reason = String(b.reason ?? "").trim().slice(0, 64);
    if (!reason) return res.status(400).json(fail(res, "INVALID_INPUT"));

    const applicationId = String(b.applicationToken ?? b.applicationId ?? "").trim() || null;
    const phone = String(b.phone ?? "").trim().slice(0, 32) || null;

    // Attach to a contact when we can, so the block shows on their CRM timeline.
    // A cold visitor has no contact and the row is still worth keeping for the count.
    let contactId: string | null = null;
    if (phone) {
      const c = await dbQuery<{ id: string }>(
        `SELECT id::text AS id FROM contacts
          WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g')
              = regexp_replace(($1)::text, '[^0-9]', '', 'g')
          LIMIT 1`,
        [phone],
      ).catch((err: unknown) => logWarnSwallowed(err, "routes/public.ts:137", ({ rows: [] as Array<{ id: string }> })));
      contactId = c.rows[0]?.id ?? null;
    }

    await dbQuery(
      `INSERT INTO wizard_block_events
         (reason, step, country, monthly_revenue, application_id, contact_id, lead_id, phone, session_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        reason,
        Number(b.step ?? 1) || 1,
        String(b.country ?? "").trim().slice(0, 8) || null,
        String(b.monthlyRevenue ?? "").trim().slice(0, 64) || null,
        applicationId,
        contactId,
        String(b.leadId ?? "").trim() || null,
        phone,
        String(b.sessionKey ?? "").trim().slice(0, 80) || null,
      ],
    ).catch((err: unknown) => { logWarnSwallowed(err, "routes/public.ts:147"); });

    // The answers never reached the application row, so put them there too -
    // that is what makes the Monthly revenue column on the abandoned list fill in.
    if (applicationId) {
      await dbQuery(
        `UPDATE applications
            SET metadata = jsonb_set(
                  jsonb_set(COALESCE(metadata,'{}'::jsonb), '{kyc}', COALESCE(metadata->'kyc','{}'::jsonb), true),
                  '{kyc,monthlyRevenue}', to_jsonb(($2)::text), true)
          WHERE id::text = ($1)::text`,
        [applicationId, String(b.monthlyRevenue ?? "")],
      ).catch((err: unknown) => { logWarnSwallowed(err, "routes/public.ts:168"); });
    }

    if (contactId) {
      // crm_notes has no created_by, and contact_id is a UUID - cast rather
      // than passing the text id straight in.
      await dbQuery(
        `INSERT INTO crm_notes (contact_id, body, silo)
         VALUES (($1)::uuid, $2, 'BF')`,
        [contactId, `Stopped at the application: ${reason}. Country ${String(b.country ?? "unknown")}, average monthly revenue ${String(b.monthlyRevenue ?? "not given")}.`],
      ).catch((err: unknown) => { logWarnSwallowed(err, "routes/public.ts:181"); });
    }

    return res.status(200).json(ok({ recorded: true }));
  }),
);

router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  wrap(async (req, res) => {
      const result = await createLead(req.body);

      if (!result?.leadId) {
        return res.status(400).json(fail(res, "INVALID_INPUT"));
      }

      // BF_SERVER_v789_CASL_EXPRESS_CONSENT - only an explicit casl_consent === true,
      // recorded on the BF contact with this email when there is one.
      await recordExpressCaslConsent(
        (sql, params) => dbQuery(sql, params as any[]),
        { email: typeof req.body?.email === "string" ? req.body.email : null, silo: "BF" },
        parseExpressCaslConsent(req.body),
        "public_api_lead",
      );

      return res.status(200).json(ok({ leadId: result.leadId }));
    }),
);

// BF_SERVER_v66_LENDER_COUNT - GET /api/public/lender-count
// Lightweight public endpoint used by the client wizard's Step 6 to
// render "Submitted to our network of {N}+ lenders." Returns
// { count: number } where N is the count of active lenders. Tolerant
// of an environment where the `active` column might be missing.
// Calls res.json() explicitly because wrap() in this codebase does
// not inspect the handler's return value and ok() from apiResponse
// only builds the envelope object without sending it.
router.get(
  "/lender-count",
  wrap(async (_req, res) => {
    let count = 0;
    try {
      const result = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM lenders WHERE COALESCE(active, true) = true`,
      );
      count = Number(result.rows?.[0]?.count ?? 0) || 0;
    } catch {
      // Defensive: if the active column is missing or the query fails for any
      // reason, fall back to a plain count so the wizard doesn't show a 404.
      try {
        const result = await dbQuery<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM lenders`,
        );
        count = Number(result.rows?.[0]?.count ?? 0) || 0;
      } catch {
        count = 0;
      }
    }
    return res.status(200).json(ok({ count }));
  }),
);

router.all("/lead", wrap(async (_req, res) => res.status(405).json(fail(res, "METHOD_NOT_ALLOWED"))));

// BF_SERVER_BLOCK_v738_PUBLIC_COLLATERAL - public download link for shareable
// collateral so SMS/messenger recipients can open it. Collateral is marketing
// material and keyed by an unguessable UUID, so no auth is required here.
router.get(
  "/collateral/:id/file",
  wrap(async (req, res) => {
    const id = String(req.params.id || "");
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!UUID.test(id)) return res.status(404).json(fail(res, "NOT_FOUND"));
    const { rows } = await dbQuery<{ name: string; content_type: string | null; blob_name: string }>(
      `SELECT name, content_type, blob_name FROM collateral_assets WHERE id = $1 LIMIT 1`,
      [id],
    );
    const row = rows[0];
    if (!row) return res.status(404).json(fail(res, "NOT_FOUND"));
    const { getStorage } = await import("../lib/storage/index.js");
    const obj = await getStorage().get(row.blob_name);
    if (!obj) return res.status(404).json(fail(res, "NOT_FOUND"));
    res.setHeader("Content-Type", row.content_type || obj.contentType || "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.name).replace(/"/g, "")}"`);
    return res.send(obj.buffer);
  }),
);

// BF_SERVER_BLOCK_v684_VISITOR_THREAD_v1
// Public (UUID-as-token) read/post for the visitor side of the messenger.
// After "Talk to a Human" the widget holds the conversation_id (unguessable
// UUID). These let the anonymous visitor receive staff replies and post
// follow-ups into the SAME communications_conversations thread the staff
// inbox (v683) reads/writes - two-way without exposing other conversations.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// BF_SERVER_v789_CONVERSATION_TOKENS - the UUID alone is no longer enough: the
// widget sends the visitor_token /api/maya/escalate issued as X-Conversation-Token
// (401 when missing, expired or for another conversation), and a read returns
// only messages created at or after that token was issued.
async function conversationAccess(req: any, res: any, id: string): Promise<{ createdAt: string } | null> {
  const header = req.headers?.[CONVERSATION_TOKEN_HEADER];
  const token = typeof header === "string" ? header.trim() : "";
  if (!token) {
    res.status(401).json(fail(res, "UNAUTHORIZED"));
    return null;
  }
  const access = await verifyConversationToken(id, token);
  if (!access) {
    res.status(401).json(fail(res, "UNAUTHORIZED"));
    return null;
  }
  return access;
}

// BF_SERVER_v789_PUBLIC_RATE_LIMITS - visitor follow-ups, 20 a minute per IP.
const conversationMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS - no validate overrides
});

router.get(
  "/conversation/:id/messages",
  wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json(fail(res, "INVALID_INPUT"));
    const access = await conversationAccess(req, res, id);
    if (!access) return;
    const result = await dbQuery<{ id: string; direction: string; body: string; created_at: string }>(
      `SELECT id, direction, body, created_at
         FROM communications_messages
        WHERE conversation_id = $1
          AND created_at >= ($2)::timestamptz
        ORDER BY created_at ASC
        LIMIT 500`,
      [id, access.createdAt],
    );
    return res.status(200).json(ok({ messages: result.rows }));
  }),
);

router.post(
  "/conversation/:id/message",
  conversationMessageLimiter,
  wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) return res.status(400).json(fail(res, "INVALID_INPUT"));
    if (!(await conversationAccess(req, res, id))) return;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    if (!body) return res.status(400).json(fail(res, "INVALID_INPUT"));
    const conv = await dbQuery<{ id: string; contact_id: string | null; silo: string | null; contact_phone: string | null }>(
      `SELECT id, contact_id, silo, contact_phone FROM communications_conversations WHERE id = $1`,
      [id],
    );
    if (!conv.rows?.[0]) return res.status(404).json(fail(res, "NOT_FOUND"));
    const convContactId = conv.rows[0].contact_id;
    const convSilo = conv.rows[0].silo ?? "BF";
    const convPhone = conv.rows[0].contact_phone;
    // BF_SERVER_BLOCK_v686_MAYA_CRM_UNIFY_v1 - carry contact_id + silo +
    // type='message' so visitor follow-ups also surface in the staff Messages
    // tab and the CRM timeline, not just the conversation_id poll.
    const inserted = await dbQuery<{ id: string; direction: string; body: string; created_at: string }>(
      `INSERT INTO communications_messages
         (id, conversation_id, contact_id, channel, type, direction, body, silo, from_number, created_at)
       VALUES (gen_random_uuid(), $1, $2, 'messenger', 'message', 'inbound', $3, $4, $5, NOW())
       RETURNING id, direction, body, created_at`,
      [id, convContactId, body, convSilo, convPhone],
    );
    await dbQuery(
      `UPDATE communications_conversations
          SET last_message_preview = $2, last_message_at = NOW(), unread = unread + 1, updated_at = NOW()
        WHERE id = $1`,
      [id, body.slice(0, 200)],
    );
    return res.status(201).json(ok({ message: inserted.rows[0] }));
  }),
);

export default router;
