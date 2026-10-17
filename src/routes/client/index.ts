import { randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { createPnwSigningSession, isPnwDocType } from "../../signnow/pnwSigning.js";
// BF_SERVER_FRAUD_ENFORCE_v50
import { isApplicationFraud, FRAUD_LOCK_MESSAGE } from "../../services/fraud/fraudGuard.js";
import continuationRouter from "./continuation.js";
import uploadFailureRouter from "./uploadFailure.js"; // BF_SERVER_UPLOAD_DIAG_v751
import documentsRouter from "./documents.js";
import applicationsRouter from "./applications.js";
import lendersRouter from "./lenders.js";
import lenderProductsRouter from "./lenderProducts.js";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes.js";
import accountantRouter from "./accountant.js"; // BF_SERVER_STEP5_ACCOUNTANT_v1
import deviceSignInRouter from "./deviceSignIn.js"; // BF_SERVER_CLIENT_FACE_ID_v296
import passkeysRouter from "./passkeys.js"; // BF_SERVER_BLOCK_v599
import productQuestionsRouter from "./productQuestions.js"; // BF_SERVER_PRODUCT_QUESTIONS_v288
import sessionRouter from "./session.js";
import { makeSigningOwnerGuard } from "./signingOwner.js"; // BF_SERVER_BLOCK_v473_SIGNING_OWNER_v1
import submitAttemptsRouter from "./submitAttempts.js";
import { clientDocumentsRateLimit } from "../../middleware/rateLimit.js";
import { rateLimitKeyFromRequest } from "../../middleware/clientIp.js"; // BF_SERVER_v791_RATE_LIMIT_KEYS
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { principalFromRequest } from "../../auth/principal.js"; // BF_SERVER_v812_CLIENT_MSG_CONTACT_LINK
import { AppError } from "../../middleware/errors.js";
import {
  clientApplicationOwnershipGuard,
  normalizeApplicationIdCandidate,
  requireApplicationAccess,
} from "../../auth/clientApplicationOwnership.js"; // BF_SERVER_v784_CLIENT_OWNERSHIP, BF_SERVER_v789_FORM_RESPONSE_AUTH
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js"; // BF_SERVER_v789_SILENT_QUERIES

const router = Router();
router.use(submitAttemptsRouter); // BF_SERVER_BLOCK_v842_SUBMIT_ATTEMPTS — frictionless beacon, before rate-limit/ownership middleware
router.use(uploadFailureRouter); // BF_SERVER_UPLOAD_DIAG_v751 - upload-failure beacon, same reason
router.use(deviceSignInRouter); // BF_SERVER_CLIENT_FACE_ID_v296 - public sign-in must not need an app id
router.use(passkeysRouter); // BF_SERVER_BLOCK_v599 - passkey sign-in, before the app-id checks
// BF_SERVER_CLIENT_APP_VERSION_v744 - phone apps built before this date are missing features the server now
// relies on (fee agreement signing, to-do buttons). The app compares its own build time and asks the client to
// update instead of showing buttons that do nothing. Raise CLIENT_APP_MIN_BUILD when a change needs a new app.
router.get("/app-version", (_req: any, res: any) => { res.json({ minBuild: process.env.CLIENT_APP_MIN_BUILD || "2026-10-04T00:00:00Z", webUrl: "https://client.boreal.financial" }); });
// BF_SERVER_CMP_READ_LIMIT_v790 - every client GET used to share the site-wide 200-per-15-minutes limiter, keyed by IP.
// The client portal polls about 25 GETs a minute, so after ~8 minutes every read failed with 429 for the rest of
// the window: the to-do list failed to load and "Sign your application documents" never appeared. Reads now get
// their own ceiling, counted per signed-in client (their session token), or per IP when there is none.
const clientReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: (req: any) => {
    const auth = String(req.headers?.authorization ?? "");
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    return token ? "tok:" + createHash("sha256").update(token).digest("hex").slice(0, 24) : "ip:" + rateLimitKeyFromRequest(req);
  }, // BF_SERVER_v791_RATE_LIMIT_KEYS - no validate overrides; the key never reads the raw request IP.
}) as any;

router.use((req: any, res: any, next: any) => {
  if (req.method === "GET") {
    clientReadLimiter(req, res, next);
    return;
  }
  next();
});

// BF_SERVER_BLOCK_v728_SOFT_APP_OWNERSHIP_v1 — defense-in-depth for the capability
// (app-id) client endpoints. App IDs are unguessable UUIDs, so this only closes the
// "logged-in client pivots to an app that isn't theirs" vector: when a request carries
// a valid OTP session token AND targets a specific applicationId, verify the app
// belongs to that phone. No token / no app id / unverifiable token -> allowed (this
// preserves SMS deep-links and the capability model). Never breaks a request on error.
// (Superseded by BF_SERVER_v784_CLIENT_OWNERSHIP below: a token is now required.)
// BF_SERVER_FRAUD_ENFORCE_v50 - an application parked in Fraud is read-only to
// the applicant: no uploads, no edits, no resubmission. Documents and history
// are kept; reactivating the file lifts this immediately.
router.use(async (req: any, res: any, next: any) => {
  try {
    const aid =
      (typeof req.query?.applicationId === "string" && req.query.applicationId.trim()) ||
      (typeof req.body?.applicationId === "string" && req.body.applicationId.trim()) ||
      "";
    if (!aid) return next();
    if (await isApplicationFraud({ query: (t: string, p?: any[]) => dbQuery(t, p) } as any, aid)) {
      return res.status(423).json({ error: "application_locked", message: FRAUD_LOCK_MESSAGE });
    }
    return next();
  } catch {
    return next();
  }
});

// BF_SERVER_v784_CLIENT_OWNERSHIP - this guard used to let token-less requests
// through and only read applicationId from query/body, so GET
// /application/:id/status, PATCH /applications/:id and friends answered anyone
// holding the id. Any request naming an existing application (query, body or
// path) now needs a valid token: a client must own it (or nobody has claimed it
// yet, mid-wizard), staff and service pass. See src/auth/clientApplicationOwnership.ts.
router.use(clientApplicationOwnershipGuard);

router.use("/", continuationRouter);
router.use("/", applicationsRouter);
router.use("/lenders", lendersRouter);
router.use("/", lenderProductsRouter);
router.use("/", clientSubmissionRoutes);
router.use("/", sessionRouter);
router.use("/", accountantRouter); // BF_SERVER_STEP5_ACCOUNTANT_v1
router.use("/", productQuestionsRouter); // BF_SERVER_PRODUCT_QUESTIONS_v288

// BF_SERVER_BLOCK_v_CLIENT_ACCOUNT_DELETE_v1 — store-required (Apple 5.1.1(v) +
// Google) account/data deletion. The CMP "Delete account" button POSTs here with
// { applicationId }. Ownership is already enforced by the client router's phone-
// match middleware (non-owners get 403 before reaching this). Hard-deletes the
// application; child rows (form responses, contacts links, messages, documents,
// packages, call events, etc.) chain via ON DELETE CASCADE
// (migration 2026_06_03_v694_application_delete_cascade.sql).
router.post("/account/delete", safeHandler(async (req: any, res: any) => {
  const applicationId =
    (typeof req.body?.applicationId === "string" && req.body.applicationId.trim()) ||
    (typeof req.query?.applicationId === "string" && req.query.applicationId.trim()) || null;
  if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) { res.status(400).json({ error: "invalid_id" }); return; }
  const { pool } = await import("../../db.js");
  // BF_SERVER_CUSTOMER_MATCH_LISTS_v711 - deletion also permanently opts out the contact.
  await pool.query(
    `UPDATE contacts SET marketing_opt_out = true, tags = array(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY['account_deleted'])), updated_at = now()
      WHERE id IN (SELECT contact_id FROM applications WHERE id::text = ($1)::text AND contact_id IS NOT NULL
                   UNION SELECT contact_id FROM application_contacts WHERE application_id::text = ($1)::text)`,
    [applicationId],
  );
  const { rowCount } = await pool.query(
    `DELETE FROM applications WHERE id::text = ($1)::text`, [applicationId]);
  if (!rowCount) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ok: true, deleted: true });
}));

// BF_SERVER_BLOCK_v_CLIENT_FORM_RESPONSES_v1 — client-authenticated form-responses.
// The CMP previously used the STAFF-gated /api/portal/.../form-responses routes,
// so the client could never save CRA/flinks/advisors/etc. These mirror the portal
// routes on the SAME application_form_responses table, but authorize via the client
// router's phone-based ownership. doc_type is the long key the forms use
// (cra_view_only_authorization, flinks_banking, ...).
{
  // BF_SERVER_v789_FORM_RESPONSE_AUTH - the path id wins, so the id that is
  // authorized is the id that is read and written.
  const formResponseApplicationId = (req: any) =>
    ((typeof req.params?.id === "string" && req.params.id.trim().toLowerCase()) ||
    (typeof req.query?.applicationId === "string" && req.query.applicationId.trim().toLowerCase()) ||
    (typeof req.body?.applicationId === "string" && req.body.applicationId.trim().toLowerCase()) ||
    null);

  // BF_SERVER_v789_FORM_RESPONSE_AUTH - no token, an invalid token or a missing
  // JWT_SECRET used to mean "allowed", so anyone holding an id (or a non-UUID id
  // the path guard skips) could read and overwrite the file's CRA / banking /
  // PNW forms. A bearer token is now required (401 otherwise) and the shared
  // ownership rule decides the rest (src/auth/clientApplicationOwnership.ts).
  const verifyFormResponseOwnership = async (req: any, res: any, appId: string) => {
    const auth = req.headers?.authorization;
    if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return false;
    }
    const normalized = normalizeApplicationIdCandidate(appId);
    if (!normalized) {
      res.status(400).json({ error: "invalid_application_id" });
      return false;
    }
    return requireApplicationAccess(req, res, normalized);
  };

  router.get(
    "/applications/:id/form-responses/:doc_type",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = await dbQuery(
        `SELECT id, doc_type, data, submitted_at, created_at, updated_at
           FROM application_form_responses
          WHERE application_id::text = ($1)::text AND doc_type = $2
          LIMIT 1`,
        [appId, docType],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "not_found" }); return; }
      res.json({ item: result.rows[0] });
    }),
  );

  router.get(
    "/applications/:id/form-responses",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = await dbQuery(
        `SELECT id, doc_type, data, submitted_at, created_at, updated_at
           FROM application_form_responses
          WHERE application_id::text = ($1)::text
          ORDER BY updated_at DESC`,
        [appId],
      );
      res.json({ items: result.rows });
    }),
  );

  router.put(
    "/applications/:id/form-responses/:doc_type",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      const data = req.body?.data;
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        res.status(400).json({ error: "data_required" });
        return;
      }
      const result = await dbQuery(
        `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
              VALUES ($1, $2, $3::jsonb, NOW())
              ON CONFLICT (application_id, doc_type)
              DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
           RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
        [appId, docType, JSON.stringify(data)],
      );
      res.json({ item: result.rows[0] });
    }),
  );

  router.post(
    "/applications/:id/form-responses/:doc_type/submit",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      const data = req.body?.data;
      const hasData = data && typeof data === "object" && !Array.isArray(data);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = hasData
        ? await dbQuery(
            `INSERT INTO application_form_responses (application_id, doc_type, data, submitted_at, updated_at)
                  VALUES ($1, $2, $3::jsonb, NOW(), NOW())
                  ON CONFLICT (application_id, doc_type)
                  DO UPDATE SET data = EXCLUDED.data, submitted_at = NOW(), updated_at = NOW()
               RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
            [appId, docType, JSON.stringify(data)],
          )
        : await dbQuery(
            `UPDATE application_form_responses
                SET submitted_at = NOW(), updated_at = NOW()
              WHERE application_id::text = ($1)::text AND doc_type = $2
              RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
            [appId, docType],
          );
      if (result.rowCount === 0) { res.status(404).json({ error: "not_found" }); return; }
      // BF_SERVER_BLOCK_v_PNW_SIGNING_v1 — sign the Personal Net Worth statement
      // individually, the instant it is submitted (its own one-signer envelope).
      let signing_url: string | null = null;
      if (isPnwDocType(docType)) {
        try { signing_url = (await createPnwSigningSession(appId)).url; }
        catch (e) { console.warn("[pnw_signing] session create failed", e instanceof Error ? e.message : String(e)); }
      }
      res.json({ item: result.rows[0], ...(signing_url ? { signing_url } : {}) });
    }),
  );
}
// BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_v1 — the CMP legitimately polls ~38 req/min
// (loadAll fans 6 GETs/15s + typing/10s + signing-complete/8s). The shared
// globalLimiter (200/15min) starved /signing-session, hiding the Sign button.
// Give authenticated client polling a realistic ceiling.
// BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_HOTFIX1 — use safeKeyGenerator (wraps
// express-rate-limit's ipKeyGenerator) instead of rateLimitKeyFromRequest,
// which threw ERR_ERL_KEY_GEN_IPV6 at construction and crashed boot.
const cmpPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: rateLimitKeyFromRequest, // BF_SERVER_v791_RATE_LIMIT_KEYS
});
router.use(cmpPollLimiter);

router.use("/documents", clientDocumentsRateLimit(), documentsRouter);

// BF_SERVER_BLOCK_v696_CLIENT_STAGE_v1 — client-accessible application stage.
// The staff /api/applications/:id surface requires APPLICATION_READ, so the
// client mini-portal cannot read its own pipeline stage there (the call 401s
// and the stage tracker silently defaults to "Received"). Expose a read-only
// stage lookup keyed by application id — the same capability model the
// mini-portal URL already relies on.
router.get(
  "/application-stage",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) {
      res.status(400).json({ error: "applicationId_required" });
      return;
    }
    // BF_SERVER_BLOCK_v549_LOCK_APPLICATION_STAGE - this returns the file's stored
    // metadata (applicant name, DOB, SIN for form prefill). It answered anyone
    // holding the application id, with no sign-in. The mini-portal is behind OTP
    // (RequireOTP), so only the signed-in owner of the file gets an answer; anyone
    // else is told the file does not exist.
    {
      const { callerOwnsApplication } = await import("../../auth/clientApplicationOwnership.js");
      if (!(await callerOwnsApplication(req, applicationId))) {
        res.status(404).json({ found: false });
        return;
      }
    }
    const result = await dbQuery(
      `select pipeline_state, status, metadata from applications where id::text = ($1)::text limit 1`,
      [applicationId]
    );
    const row = result.rows[0];
    if (!row) {
      res.status(200).json({ found: false });
      return;
    }
    res.status(200).json({
      found: true,
      pipeline_state: row.pipeline_state ?? null,
      status: row.status ?? null,
      metadata: row.metadata ?? null,
    });
  })
);

// BF_SERVER_v802_CLIENT_ADVISOR - the client app's Home shows who is looking after the file:
// the application's owner, else the contact's owner, when that person is active staff. Its own
// route (read once per application) because the photo can be a large data URL and the stage
// route above is polled every 30 seconds. bookable = the advisor takes calls through /api/booking.
router.get(
  "/advisor",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) {
      res.status(400).json({ error: "applicationId_required" });
      return;
    }
    const { callerOwnsApplication } = await import("../../auth/clientApplicationOwnership.js");
    if (!(await callerOwnsApplication(req, applicationId))) {
      res.status(404).json({ found: false });
      return;
    }
    const result = await dbQuery(
      `select u.id::text as id, u.first_name, u.last_name, u.profile_image_url
         from (select a.owner_user_id as uid, 1 as pri from applications a where a.id::text = ($1)::text
               union all
               select c.owner_id, 2 from applications a join contacts c on c.id = a.contact_id where a.id::text = ($1)::text) o
         join users u on u.id = o.uid
        where u.role in ('Admin', 'Staff', 'Ops', 'Marketing')
          and u.active is not false
          and coalesce(u.disabled, false) = false
          and coalesce(u.status, 'ACTIVE') = 'ACTIVE'
        order by o.pri
        limit 1`,
      [applicationId]
    );
    const row = result.rows[0] as { id: string; first_name: string | null; last_name: string | null; profile_image_url: string | null } | undefined;
    if (!row) {
      res.status(200).json({ advisor: null });
      return;
    }
    let bookable = false;
    try {
      const { bookableStaff } = await import("../../services/clientBooking.js");
      bookable = (await bookableStaff()).some((s) => s.id === row.id);
    } catch (err) {
      console.warn("[client] advisor bookable check failed", { message: err instanceof Error ? err.message : String(err) });
    }
    const photo = typeof row.profile_image_url === "string" ? row.profile_image_url.trim() : "";
    res.status(200).json({
      advisor: {
        id: row.id,
        firstName: (row.first_name ?? "").trim() || null,
        lastName: (row.last_name ?? "").trim() || null,
        // https links and image data URLs up to ~400 KB; anything else is left out.
        photoUrl: /^https:\/\//i.test(photo) || (/^data:image\//i.test(photo) && photo.length <= 400_000) ? photo : null,
        bookable,
      },
    });
  })
);

// BF_SERVER_v807_CLIENT_PROFILE - the client edits their own details in the app's Settings (name, email,
// business name). It updates the CRM contact on the file and the application, so staff see the same thing.
// The mobile number is the sign-in number and is not changed here.
export function cleanProfileInput(body: any): { ok: true; firstName: string; lastName: string; email: string; businessName: string } | { ok: false; error: string } {
  const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const firstName = text(body?.firstName, 80);
  const lastName = text(body?.lastName, 80);
  const email = text(body?.email, 160).toLowerCase();
  const businessName = text(body?.businessName, 160);
  if (!firstName) return { ok: false, error: "first_name_required" };
  if (!lastName) return { ok: false, error: "last_name_required" };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "email_invalid" };
  if (!businessName) return { ok: false, error: "business_name_required" };
  return { ok: true, firstName, lastName, email, businessName };
}

router.post(
  "/profile",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
      res.status(400).json({ error: "applicationId_required" });
      return;
    }
    const { callerOwnsApplication } = await import("../../auth/clientApplicationOwnership.js");
    if (!(await callerOwnsApplication(req, applicationId))) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const input = cleanProfileInput(req.body);
    if (!input.ok) {
      res.status(400).json({ error: input.error });
      return;
    }
    const fullName = input.firstName + " " + input.lastName;
    const app = await dbQuery(
      `UPDATE applications
          SET name = $2,
              metadata = jsonb_set(
                jsonb_set(
                  jsonb_set(
                    jsonb_set(COALESCE(metadata, '{}'::jsonb), '{applicant}', COALESCE(metadata->'applicant', '{}'::jsonb), true),
                    '{applicant,firstName}', to_jsonb($3::text), true),
                  '{applicant,lastName}', to_jsonb($4::text), true),
                '{applicant,email}', to_jsonb($5::text), true)
                || jsonb_build_object('business', COALESCE(metadata->'business', '{}'::jsonb) || jsonb_build_object('name', $2::text)),
              updated_at = now()
        WHERE id::text = ($1)::text
        RETURNING contact_id::text AS contact_id`,
      [applicationId, input.businessName, input.firstName, input.lastName, input.email],
    );
    const contactId = (app.rows[0] as { contact_id: string | null } | undefined)?.contact_id ?? null;
    if (!app.rows[0]) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (contactId) {
      await dbQuery(
        `UPDATE contacts SET first_name = $2, last_name = $3, name = $4, email = $5, company_name = $6, updated_at = now()
          WHERE id::text = ($1)::text`,
        [contactId, input.firstName, input.lastName, fullName, input.email, input.businessName],
      );
    }
    console.info("[client] profile_updated", { applicationId, contactId });
    res.status(200).json({ ok: true, profile: { firstName: input.firstName, lastName: input.lastName, email: input.email, businessName: input.businessName } });
  })
);

// BF_SERVER_v809_SMS_UPDATES_CONSENT - the client sees and changes "Text me updates about my application" in
// the client portal's Details. The choice belongs to the signed-in client's own mobile number (from the token),
// so no application id is needed and nobody can change another person's choice.
async function signedInClientPhone(req: any): Promise<string> {
  const { principalFromRequest } = await import("../../auth/principal.js");
  const p = principalFromRequest(req);
  if (!p || p.kind !== "client") return "";
  return String(p.phone ?? "").replace(/[^0-9]/g, "").slice(-10);
}

router.get(
  "/sms-updates",
  safeHandler(async (req: any, res: any) => {
    const phone = await signedInClientPhone(req);
    if (!phone) { res.status(401).json({ error: "unauthorized" }); return; }
    const { getSmsUpdatesConsent } = await import("../../services/smsUpdatesConsent.js");
    res.status(200).json({ smsUpdates: (await getSmsUpdatesConsent(phone)) === true });
  })
);

router.post(
  "/sms-updates",
  safeHandler(async (req: any, res: any) => {
    const phone = await signedInClientPhone(req);
    if (!phone) { res.status(401).json({ error: "unauthorized" }); return; }
    if (typeof req.body?.smsUpdates !== "boolean") { res.status(400).json({ error: "smsUpdates_boolean_required" }); return; }
    const { recordSmsUpdatesConsent } = await import("../../services/smsUpdatesConsent.js");
    const ok = await recordSmsUpdatesConsent(phone, req.body.smsUpdates, "client_portal");
    if (!ok) { res.status(503).json({ error: "not_saved" }); return; }
    res.status(200).json({ ok: true, smsUpdates: req.body.smsUpdates });
  })
);

// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1 — client-accessible embedded
// signing session for the CMP iframe (our application + each finalized lender form).
router.get(
  "/signing-session",
  // BF_SERVER_BLOCK_v473_SIGNING_OWNER_v1 - signing links need the client login + phone match
  makeSigningOwnerGuard((t: string, p?: unknown[]) => dbQuery(t, p as any[])),
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const mod = await import("../../signnow/embeddedSigningSession.js");
    const result = await mod.getOrCreateEmbeddedSigningSession(applicationId);
    res.status(200).json(result);
  })
);

// BF_SERVER_MEDIA_FEE_AGREEMENT_v709 - the client signs the media fee agreement
// in the CMP. A signing link lets the holder sign, so it is owner-guarded like
// /signing-session. /fee-agreement/complete verifies with SignNow before marking.
router.get(
  "/fee-agreement",
  makeSigningOwnerGuard((t: string, p?: unknown[]) => dbQuery(t, p as any[])),
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const { getFeeAgreement } = await import("../../services/feeAgreement/mediaFeeAgreement.js");
    const ag = await getFeeAgreement(applicationId);
    res.status(200).json(ag
      ? { required: true, status: ag.status, signerIsApplicant: ag.signer_is_applicant, signerName: ag.signer_name, signedAt: ag.signed_at }
      : { required: false });
  })
);
router.get(
  "/fee-agreement/session",
  makeSigningOwnerGuard((t: string, p?: unknown[]) => dbQuery(t, p as any[])),
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const { createFeeAgreementSigningSession } = await import("../../services/feeAgreement/mediaFeeAgreement.js");
    try {
      res.status(200).json(await createFeeAgreementSigningSession(applicationId));
    } catch (e) {
      console.warn("[fee-agreement] session failed", { applicationId, message: e instanceof Error ? e.message : String(e) });
      // BF_SERVER_v789_GENERIC_ERRORS - the detail stays in the log above; the client gets a generic code only.
      res.status(200).json({ status: "error", reason: "session_failed" });
    }
  })
);
router.post(
  "/fee-agreement/complete",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim()
        : typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const { confirmFeeAgreementSigned } = await import("../../services/feeAgreement/mediaFeeAgreement.js");
    try {
      res.status(200).json({ ok: true, ...(await confirmFeeAgreementSigned(applicationId)) });
    } catch (e) {
      console.warn("[fee-agreement] confirm failed", { applicationId, message: e instanceof Error ? e.message : String(e) });
      res.status(200).json({ ok: true, signed: false, reason: "status_check_failed" });
    }
  })
);

// BF_SERVER_BLOCK_v476_CLIENT_OFFERS_v1 - the client mini-portal read offers from
// the staff-only GET /api/offers (Admin/Staff roles), so every client got 403 and
// never saw an offer. Same columns, owner-guarded like the signing link.
router.get(
  "/offers",
  makeSigningOwnerGuard((t: string, p?: unknown[]) => dbQuery(t, p as any[])),
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const r = await dbQuery(
      `SELECT o.id, o.application_id, o.lender_name, o.amount::text AS amount, o.rate_factor, o.term,
              o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
         FROM offers o
        WHERE o.application_id::text = ($1)::text
        ORDER BY o.updated_at DESC`,
      [applicationId]
    );
    const { attachTermSheetUrls } = await import("../offers.js");
    res.status(200).json({ items: await attachTermSheetUrls(r.rows) });
  })
);

// BF_SERVER_BLOCK_v476_CLIENT_REJECTED_DOCS_v1 - the rejected-documents banner read
// the staff-only GET /api/applications/:id/documents and always got 403.
router.get(
  "/rejected-documents",
  makeSigningOwnerGuard((t: string, p?: unknown[]) => dbQuery(t, p as any[])),
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const r = await dbQuery(
      `SELECT d.id::text AS id, d.category, d.filename, d.status, d.rejection_reason, d.updated_at
         FROM documents d
        WHERE d.application_id::text = ($1)::text
          AND lower(coalesce(d.status, '')) = 'rejected'
        ORDER BY d.updated_at DESC`,
      [applicationId]
    );
    res.status(200).json({ items: r.rows });
  })
);

// BF_SERVER_BLOCK_v_CLIENT_SIGNING_COMPLETE_v1 — the SignNow webhook does not
// reliably fire, so the signed stamp + lender-package dispatch never happen.
// The CMP calls this when the signing iframe completes / closes; we VERIFY with
// SignNow (field-invite statuses) that every invite is fulfilled before marking
// signed, so a client can never fake it. On confirmed-signed we run the exact
// finalize path the admin mark-signed route uses.
router.post(
  "/signing-complete",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string"
        ? req.query.applicationId.trim()
        : typeof req.body?.applicationId === "string"
          ? req.body.applicationId.trim()
          : null;
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const { pool } = await import("../../db.js");
    const appRes = await pool.query<{ contact_id: string | null; signnow_app_signed_at: string | null; group_id: string | null }>(
      `SELECT contact_id, signnow_app_signed_at,
              (metadata->'signnow_embedded'->>'group_id') AS group_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    if (!appRes.rows.length) { res.status(404).json({ error: "not_found" }); return; }
    const row = appRes.rows[0];
    if (row.signnow_app_signed_at) { res.json({ ok: true, signed: true, alreadySigned: true }); return; }
    const groupId = row.group_id;
    if (!groupId) { res.json({ ok: true, signed: false, reason: "no_signing_group" }); return; }

    let signed = false; let summary = "";
    try {
      const snow = await import("../../signnow/signnowClient.js");
      const st = await snow.getDocumentGroupStatus(String(groupId));
      signed = !!st.signed; summary = st.summary;
    } catch (e: any) {
      // BF_SERVER_v789_GENERIC_ERRORS - log the SignNow detail, return a generic code.
      console.warn("[signing-complete] status check failed", { applicationId, message: e?.message ?? String(e) });
      res.json({ ok: true, signed: false, reason: "status_check_failed" });
      return;
    }
    if (!signed) { res.json({ ok: true, signed: false, summary }); return; }

    const { finalizeSignedApplication } = await import("../../signnow/finalizeSignedApplication.js");
    const fired = await finalizeSignedApplication(
      { id: applicationId, contactId: row.contact_id ?? null },
      { documentId: null }
    );
    await pool.query(
      `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now()
         WHERE id::text = ($1)::text
           AND pipeline_state NOT IN ('Off to Lender','Offer','Accepted','Rejected','Declined','Funded','Closed')
           AND EXISTS (SELECT 1 FROM application_packages p
                        WHERE p.application_id::text = ($1)::text AND p.status = 'sent')`,
      [applicationId]
    );
    res.json({ ok: true, signed: true, finalized: fired, summary });
  })
);

// BF_SERVER_PREFILL_OWN_PHONE_v778
export function signedInPhone10(req: any): string {
  const auth = req.headers?.authorization;
  const secret = process.env.JWT_SECRET;
  if (!secret || typeof auth !== "string" || !auth.startsWith("Bearer ")) return "";
  try {
    const decoded = jwt.verify(auth.slice(7), secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    return String(typeof decoded.phone === "string" ? decoded.phone : "").replace(/[^0-9]/g, "").slice(-10);
  } catch { return ""; }
}
// ID numbers and banking are matched by whole words in the key ("partnerSsn", "SINNumber", "bankAccount"), never by
// letters: "businessName" contains both "sin" and "ssn".
const PREFILL_NEVER_WORDS = new Set(["ssn", "sin", "ein", "bn", "bank", "routing", "transit", "institution", "password", "signature", "token", "card"]);
const PREFILL_NEVER_KEYS = new Set(["businessnumber", "taxid", "identitynumber", "idnumber", "socialinsurancenumber", "socialsecuritynumber", "accountnumber"]);
const prefillNever = (k: string) => {
  const words = k.split(/(?=[A-Z][a-z])|[_\-\s]+/).map((w) => w.toLowerCase()).filter(Boolean);
  return PREFILL_NEVER_KEYS.has(k.toLowerCase().replace(/[_\-\s]/g, "")) || words.some((w) => PREFILL_NEVER_WORDS.has(w));
};
export function safePrefillFields(obj: unknown): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (prefillNever(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

router.get(
  "/readiness-prefill",
  safeHandler(async (req: any, res: any) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : null;
    const token = typeof req.query.token === "string" ? req.query.token.trim() : null;

    if (!phone && !token) {
      res.status(400).json({ error: "phone_or_token_required" });
      return;
    }

    // BF_SERVER_PREFILL_OWN_PHONE_v778 - the phone lookup answered anyone who guessed a number with that person's name,
    // email, company and revenue answers. It now answers only the signed-in client, about their own number. (The
    // website hand-off by readiness token is unchanged.)
    if (!token && phone) {
      const mine = signedInPhone10(req);
      const asked = phone.replace(/[^0-9]/g, "").slice(-10);
      if (!mine || mine !== asked) {
        console.warn("[readiness-prefill] phone lookup refused", { signedIn: Boolean(mine), match: false });
        res.status(200).json({ found: false });
        return;
      }
    }

    let row: Record<string, any> | undefined;
    if (token) {
      const result = await dbQuery(
        `select * from readiness_sessions where id = $1 and is_active = true limit 1`,
        [token]
      );
      row = result.rows[0];
    } else {
      // BF_SERVER_BLOCK_v129a_READINESS_PHONE_NORMALIZE_v1
      // BF_SERVER_PREFILL_OWN_PHONE_v778 - the regex was written '\D' inside a template literal, which JavaScript turns
      // into a plain 'D', so this stripped the letter D instead of every non-digit and formatted numbers never matched.
      // Digit-equivalence lookup. Legacy readiness_sessions rows may have
      // raw display format ("(403) 555-1234"); newer rows have E.164
      // ("+14035551234"). Strip both sides to digits. Compare last-10-
      // digit slice so 10-digit and 11-digit (1XXXXXXXXXX) variants both
      // match. Length guard prevents partial-input false positives.
      const result = await dbQuery(
        `select * from readiness_sessions
          where right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10)
                = right(regexp_replace($1, '\\D', '', 'g'), 10)
            and length(regexp_replace(coalesce(phone, ''), '\\D', '', 'g')) >= 10
            and is_active = true
          order by created_at desc limit 1`,
        [phone]
      );
      row = result.rows[0];
    }

    // READINESS_PREFILL_CRM_FALLBACK_v1 - a returning client who OTP's straight
    // into the wizard (never did the marketing-site readiness check) has no
    // readiness_sessions row, so the wizard used to open blank even though we
    // already know them from their CRM contact + prior applications. When the
    // phone path finds no readiness session, fall back to their most recent
    // application and hydrate the same prefill shape from contact columns +
    // application.metadata->'kyc'. Token path is unaffected.
    if (!row && phone) {
      const appResult = await dbQuery(
        `SELECT c.name AS full_name, c.first_name, c.company_name, c.email, c.phone,
                COALESCE(a.metadata->'kyc'->>'industry', a.metadata->>'industry',
                         a.metadata->'formData'->'kyc'->>'industry') AS industry,
                COALESCE(a.metadata->'kyc'->>'businessLocation', a.metadata->>'businessLocation') AS business_location,
                COALESCE(a.metadata->'kyc'->>'fundingType', a.metadata->'kyc'->>'lookingFor', a.metadata->>'fundingType') AS funding_type,
                COALESCE(a.metadata->'kyc'->>'purposeOfFunds', a.metadata->>'purposeOfFunds') AS purpose_of_funds,
                COALESCE(a.metadata->'kyc'->>'requestedAmount', a.metadata->'kyc'->>'fundingAmount', a.requested_amount::text) AS requested_amount,
                COALESCE(a.metadata->'kyc'->>'salesHistory', a.metadata->'kyc'->>'yearsInBusiness') AS sales_history_years,
                COALESCE(a.metadata->'kyc'->>'revenueLast12Months', a.metadata->'kyc'->>'annualRevenue') AS annual_revenue_range,
                a.metadata->'kyc'->>'monthlyRevenue' AS avg_monthly_revenue_range,
                COALESCE(a.metadata->'kyc'->>'accountsReceivable', a.metadata->'kyc'->>'arBalance') AS accounts_receivable_range,
                COALESCE(a.metadata->'kyc'->>'fixedAssets', a.metadata->'kyc'->>'availableCollateral') AS fixed_assets_value_range,
                a.metadata->'business' AS business, a.metadata->'applicant' AS applicant -- BF_SERVER_PREFILL_OWN_PHONE_v778
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10)
                = right(regexp_replace($1, '\\D', '', 'g'), 10)
            AND length(regexp_replace($1, '\\D', '', 'g')) >= 10
            AND a.silo = 'BF'
          ORDER BY a.updated_at DESC NULLS LAST, a.created_at DESC
          LIMIT 1`,
        [phone]
      );
      const c = appResult.rows[0];
      if (c) {
        res.status(200).json({
          found: true,
          source: "crm",
          prefill: {
            companyName: c.company_name ?? null,
            fullName: c.full_name ?? null,
            email: c.email ?? null,
            phone: c.phone ?? phone,
            industry: c.industry ?? null,
            businessLocation: c.business_location ?? null,
            fundingType: c.funding_type ?? null,
            requestedAmount: c.requested_amount ?? null,
            purposeOfFunds: c.purpose_of_funds ?? null,
            salesHistoryYears: c.sales_history_years ?? null,
            annualRevenueRange: c.annual_revenue_range ?? null,
            avgMonthlyRevenueRange: c.avg_monthly_revenue_range ?? null,
            accountsReceivableRange: c.accounts_receivable_range ?? null,
            fixedAssetsValueRange: c.fixed_assets_value_range ?? null,
            yearsInBusiness: c.sales_history_years ?? null,
            annualRevenue: c.annual_revenue_range ?? null,
            profitable: null,
            existing_debt: null,
            score: null,
            // BF_SERVER_PREFILL_OWN_PHONE_v778 - business and owner details from the last application, so a returning
            // client does not retype them. ID numbers and banking details are never sent back.
            business: safePrefillFields(c.business),
            applicant: safePrefillFields(c.applicant),
          },
        });
        return;
      }
      // BF_SERVER_PREFILL_OWN_PHONE_v778 - known to the CRM (a call, a web lead) but no application yet.
      const contact = await dbQuery(
        `SELECT name, company_name, email, phone FROM contacts
          WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right(regexp_replace($1, '\\D', '', 'g'), 10)
            AND length(regexp_replace($1, '\\D', '', 'g')) >= 10
            AND coalesce(silo, 'BF') = 'BF'
          ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
        [phone]
      );
      const k = contact.rows[0];
      if (k && (k.name || k.email || k.company_name)) {
        res.status(200).json({ found: true, source: "contact", prefill: { companyName: k.company_name ?? null, fullName: k.name ?? null, email: k.email ?? null, phone: k.phone ?? phone } });
        return;
      }
    }

    if (!row) {
      res.status(200).json({ found: false });
      return;
    }

    res.status(200).json({
      found: true,
      prefill: {
        // Identity
        companyName: row.company_name ?? null,
        fullName: row.full_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        // Business profile
        industry: row.industry ?? null,
        businessLocation: row.business_location ?? null,
        // Funding profile
        fundingType: row.funding_type ?? null,
        requestedAmount: row.requested_amount ?? null,
        purposeOfFunds: row.purpose_of_funds ?? null,
        // Financial profile (V1 14-field bucket strings)
        salesHistoryYears: row.sales_history_years ?? null,
        annualRevenueRange: row.annual_revenue_range ?? null,
        avgMonthlyRevenueRange: row.avg_monthly_revenue_range ?? null,
        accountsReceivableRange: row.accounts_receivable_range ?? null,
        fixedAssetsValueRange: row.fixed_assets_value_range ?? null,
        // Legacy fields kept for back-compat
        yearsInBusiness: row.years_in_business ?? null,
        annualRevenue: row.annual_revenue ?? null,
        profitable: typeof row.profitable === "boolean" ? row.profitable : null,
        existing_debt: typeof row.existing_debt === "boolean" ? row.existing_debt : null,
        score: row.score ?? null,
      },
    });
  })
);

// BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1
router.get(
  "/messages",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    // v636: presence bump. Mini-portal polls this every 20s while the tab is
    // visible. POST /communications/messages/send reads last_portal_seen_at to
    // decide whether to fire the offline-fallback SMS.
    await dbQuery(
      `UPDATE applications SET last_portal_seen_at = now() WHERE id = $1`,
      [applicationId]
    ).catch((err: unknown) => logWarnSwallowed(err, "routes/client/index.ts:713", undefined));

    // v636: include `direction` + `cta_label` + `cta_action` so MiniPortalPage
    // maps inbound→self / outbound→other correctly and MessageThread renders
    // the inline CTA bubble (screenshot 2 — "Complete Personal Net Worth").
    // BF_CLIENT_THREAD_CONTACT_SCOPE_v1 - staff threads are contact-keyed, so a
    // reply carries whichever application the portal resolved as "most recent"
    // for that contact, or none at all. Filtering on application_id alone meant
    // any client holding more than one application read a thread the reply was
    // never stamped with. Match on the contact behind this application so the
    // client sees the same single conversation staff do.
    const rows = await dbQuery(
      // BF_CLIENT_THREAD_TYPES_v2 - $1 is compared against applications.id AND
      // communications_messages.application_id in the same statement. Those
      // columns are not the same type, so without an explicit cast Postgres
      // cannot deduce one type for the parameter and the statement fails,
      // which the caller's catch turns into an empty thread. Casting both
      // sides to text is what every other query in this file does.
      `WITH thread AS (
         SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1
       )
       SELECT id, direction, body, staff_name, cta_label, cta_action, attachments, created_at, read_at /* BF_SERVER_BLOCK_v507 */,
              type, media_url /* BF_SERVER_v819_CLIENT_MMS - texted pictures show as an attachment, not "[media]" */
       FROM communications_messages
       -- BF_SERVER_THREAD_PER_APP_v1: this application's own messages, plus only
       -- contact-level messages not tied to any application.
       WHERE application_id::text = ($1)::text
          OR (
               application_id IS NULL
           AND (SELECT contact_id FROM thread) IS NOT NULL
           AND contact_id::text = (SELECT contact_id::text FROM thread)
             )
       ORDER BY created_at ASC
       LIMIT 200`,
      [applicationId]
    );

    // BF_SERVER_BLOCK_v778_HIDE_COMPLETED_TASKS — once a client finishes a task
    // (submits a CMP form, uploads the gov-ID / required docs, re-uploads a
    // rejected doc), drop that task's prompt message from the thread so only
    // outstanding to-dos remain. Each lookup degrades to "nothing completed" on
    // error, so a schema surprise just leaves the thread unchanged.
    const v778_forms = await dbQuery(
      `SELECT doc_type FROM application_form_responses WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
      [applicationId]
    ).catch((err: any) => { console.warn("[silent-query] routes/client/index.ts", { message: err?.message }); return { rows: [] as any[] }; });
    const v778_docs = await dbQuery(
      `SELECT DISTINCT lower(coalesce(category,'')) AS category FROM documents WHERE application_id::text = ($1)::text AND coalesce(status,'') <> 'rejected'`,
      [applicationId]
    ).catch((err: any) => { console.warn("[silent-query] routes/client/index.ts", { message: err?.message }); return { rows: [] as any[] }; });
    // BF_SERVER_CLIENT_NO_DOC_REQUIREMENTS_v623 - that table does not exist in the live
    // database; the query failed every 30 s. v561 below is the real answer.
    const v778_req = { rows: [] as Array<{ category?: string }> };
    const v778_formKey = (dt: any): string | null => {
      const s = String(dt ?? "").toLowerCase();
      if (/cra/.test(s)) return "cra";
      if (/net.?worth/.test(s)) return "networth";
      if (/advisor/.test(s)) return "advisors";
      if (/debt/.test(s)) return "debt";
      if (/equipment/.test(s)) return "equipment";
      if (/real.?estate/.test(s)) return "realestate";
      if (/flinks|bank/.test(s)) return "flinks";
      return null;
    };
    const v778_completed = new Set<string>();
    for (const r of (v778_forms.rows ?? [])) { const k = v778_formKey((r as any).doc_type); if (k) v778_completed.add(k); }
    const v778_uploaded = new Set<string>((v778_docs.rows ?? []).map((r: any) => String(r.category || "")).filter(Boolean));
    if ([...v778_uploaded].some((c) => /gov|government|photo.?id|identification|\bid\b/.test(c))) v778_completed.add("upload");
    const v778_required: string[] = (v778_req.rows ?? []).map((r: any) => String(r.category || "")).filter(Boolean);
    const v778_stillNeeded = v778_required.filter((c) => !v778_uploaded.has(c));
    // BF_SERVER_BLOCK_v561 - "all documents in" is the client's live upload list
    // (waiver-aware, same answer as the to-do panel), not document_requirements.
    let v561_docsClear = v778_required.length > 0 && v778_stillNeeded.length === 0;
    try {
      const { computeOutstandingDocs } = await import("../clientDocumentsNeeded.js");
      const o = await computeOutstandingDocs(applicationId);
      v561_docsClear = o.stillNeeded.length === 0 && o.rejected.length === 0;
    } catch (err: any) {
      console.warn("[client/messages] outstanding_docs_failed", { applicationId, message: err?.message });
    }
    if (v561_docsClear) v778_completed.add("upload_docs");
    const V778_TASK_KEYS = new Set<string>(["cra", "networth", "advisors", "debt", "equipment", "realestate", "flinks", "upload", "upload_docs"]);
    const v778_isTask = (cta: any): boolean => { if (!cta) return false; let k = String(cta); if (k.startsWith("form:")) k = k.slice(5); return V778_TASK_KEYS.has(k) || k.startsWith("upload:"); };
    const v778_isDone = (cta: any): boolean => {
      if (!cta) return false;
      let k = String(cta);
      if (k.startsWith("form:")) k = k.slice(5);
      if (k.startsWith("upload:")) {
        const t = k.slice(7).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!t) return false;
        return [...v778_uploaded].some((c) => { const cc = c.replace(/[^a-z0-9]/g, ""); return !!cc && (cc.includes(t) || t.includes(cc)); });
      }
      return v778_completed.has(k);
    };
    let v778_rows = (rows.rows ?? []).filter((r: any) => !v778_isDone(r.cta_action));
    // BF_SERVER_BANK_CRA_ON_REQUEST_v691 - hide the old automatic Connect Bank / CRA prompts; staff-requested ones stay.
    v778_rows = v778_rows.filter((r: any) => !(r.staff_name == null && ["cra", "flinks", "form:cra", "form:flinks"].includes(String(r.cta_action ?? ""))));
    // BF_SERVER_BLOCK_v563 - no PGI prompt until the client has signed a term sheet.
    if (v778_rows.some((r: any) => r.cta_label === "Complete PGI Application")) {
      const { termSheetSigned } = await import("../../services/termSheetSigned.js");
      if (!(await termSheetSigned(applicationId))) {
        v778_rows = v778_rows.filter((r: any) => r.cta_label !== "Complete PGI Application");
      }
    }
    // BF_SERVER_BLOCK_v561 - with nothing left to upload, the automated checklist
    // notes go too. With the PGI application done, its prompt goes. What remains is
    // open work and the real conversation between the client and staff.
    if (v561_docsClear) {
      v778_rows = v778_rows.filter((r: any) => !(!r.cta_action && typeof r.body === "string"
        && /^(We've added more documents to your checklist|To continue your application, please upload)/.test(r.body)));
    }
    // BF_SERVER_CHAT_IS_CHAT_v629 - every to-do (documents to upload, forms to fill) lives
    // in the client's "What you need to do" panel, which is computed live. The task
    // prompts posted into the thread froze their text when posted, so they asked for
    // documents already sent and vanished all at once when the last item arrived. The
    // thread is now conversation only: task buttons and automated checklist notes are
    // left out. They stay in the database, so staff history is unchanged.
    // BF_SERVER_TODO_PROMPTS_v635 - the PGI and SBA forms prompts live in "What you need to do" too.
    v778_rows = v778_rows.filter((r: any) => r.cta_label !== "Complete PGI Application" && r.cta_action !== "sba_forms" && r.cta_action !== "form:sba_forms");
    v778_rows = v778_rows.filter((r: any) => !v778_isTask(r.cta_action)
      && !(typeof r.body === "string" && /^(We've added more documents to your checklist|To continue your application, please upload|Please complete the .+ step to continue your application)/.test(r.body)));
    if (v778_rows.some((r: any) => r.cta_label === "Complete PGI Application")) {
      const { pgiDone, pgiStageFor } = await import("../../services/pgiStage.js");
      if (pgiDone(await pgiStageFor(applicationId))) {
        v778_rows = v778_rows.filter((r: any) => r.cta_label !== "Complete PGI Application");
      }
    }
    if (!v778_rows.some((r: any) => v778_isTask(r.cta_action))) {
      v778_rows = v778_rows.filter((r: any) => !(typeof r.body === "string" && /few quick steps to finish/i.test(r.body)));
    }

    res.status(200).json({
      status: "ok",
      data: v778_rows.map((r: any) => ({
        id: r.id,
        direction: r.direction,
        staff_name: r.staff_name ?? null,
        cta_label: r.cta_label ?? null,
        cta_action: r.cta_action ?? null,
        // BF_SERVER_v819_CLIENT_MMS - a picture the client texted in is a row with media_url and a "[media]"
        // placeholder body. The client gets an attachment pointing at the owner-guarded media route below, never
        // the stored URL itself.
        ...clientMmsView(r, applicationId),
        created_at: r.created_at,
        read_at: r.read_at ?? null, // BF_SERVER_BLOCK_v507_READ_RECEIPTS
      })),
    });
  })
);

// BF_SERVER_v819_CLIENT_MMS - best guess at what a stored media URL holds. Twilio media URLs carry no extension;
// persisted blob copies do (see extFromContentType in services/mmsMedia.ts). Phone MMS is almost always a picture,
// so an unknown type is treated as a JPEG.
export function guessMediaContentType(mediaUrl: string): string {
  let path = "";
  try { path = new URL(mediaUrl).pathname.toLowerCase(); } catch { path = String(mediaUrl || "").toLowerCase(); }
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  const byExt: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    pdf: "application/pdf", mp4: "video/mp4",
  };
  return byExt[ext] ?? "image/jpeg";
}

// BF_SERVER_v819_CLIENT_MMS - body + attachments for one client thread row. A row without media_url is unchanged.
export function clientMmsView(r: any, applicationId: string): { body: any; attachments: any[] | null } {
  const existing = Array.isArray(r.attachments) ? r.attachments : null;
  const mediaUrl = typeof r.media_url === "string" ? r.media_url.trim() : "";
  if (!mediaUrl) return { body: r.body, attachments: existing };
  const contentType = guessMediaContentType(mediaUrl);
  const attachment = {
    name: contentType.startsWith("image/") ? "Picture" : "File",
    contentType,
    url: `/api/client/messages/${encodeURIComponent(String(r.id))}/media?applicationId=${encodeURIComponent(applicationId)}`,
  };
  return {
    body: typeof r.body === "string" && r.body.trim() === "[media]" ? "" : r.body,
    attachments: [...(existing ?? []), attachment],
  };
}

// BF_SERVER_v819_CLIENT_MMS - only these types are served inline; anything else downloads as a plain file so a
// stored HTML/SVG copy can never render on the API origin.
const CLIENT_MEDIA_INLINE = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf|video\/mp4|audio\/[a-z0-9.+-]+)$/i;

// BF_SERVER_v819_CLIENT_MMS - the picture/file behind a thread message. Same thread WHERE as GET /messages, and the
// caller must own the application (the router guard already ran; checked again here so the route never depends
// on it). Fetching mirrors the staff proxy GET /api/communications/messages/:id/media.
router.get(
  "/messages/:id/media",
  safeHandler(async (req: any, res: any) => {
    const id = String(req.params?.id ?? "").trim().toLowerCase();
    const applicationId = normalizeApplicationIdCandidate(typeof req.query.applicationId === "string" ? req.query.applicationId : "");
    if (!applicationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const auth = req.headers?.authorization;
    if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!(await requireApplicationAccess(req, res, applicationId))) return;

    const found = await dbQuery<{ media_url: string | null }>(
      `WITH thread AS (
         SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1
       )
       SELECT media_url
       FROM communications_messages
       WHERE id::text = ($2)::text
         AND (
               application_id::text = ($1)::text
            OR (
                 application_id IS NULL
             AND (SELECT contact_id FROM thread) IS NOT NULL
             AND contact_id::text = (SELECT contact_id::text FROM thread)
               )
             )
       LIMIT 1`,
      [applicationId, id],
    );
    const mediaUrl = found.rows[0]?.media_url ? String(found.rows[0].media_url) : "";
    if (!mediaUrl) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { fetchTwilioMedia, persistTwilioMediaToBlob } = await import("../../services/mmsMedia.js");
    let buf: Buffer;
    let ct = "";
    if (/^https:\/\/api\.twilio\.com\//i.test(mediaUrl)) {
      const persisted = await persistTwilioMediaToBlob(mediaUrl);
      if (persisted) {
        await dbQuery("UPDATE communications_messages SET media_url = $2 WHERE id::text = ($1)::text", [id, persisted.url])
          .catch((err: unknown) => logWarnSwallowed(err, "routes/client/index.ts:v819_media_persist", undefined));
        ct = persisted.contentType;
        buf = persisted.buffer;
      } else {
        const direct = await fetchTwilioMedia(mediaUrl);
        if (!direct) {
          console.warn("[client-mms-media] twilio fetch failed", { id });
          res.status(502).json({ error: "media_unavailable" });
          return;
        }
        ct = direct.contentType;
        buf = direct.buffer;
      }
    } else if (/^https:\/\//i.test(mediaUrl)) {
      try {
        const upstream = await fetch(mediaUrl);
        if (!upstream.ok) {
          console.warn("[client-mms-media] stored copy unreadable", { id, status: upstream.status });
          res.status(502).json({ error: "media_unavailable" });
          return;
        }
        ct = upstream.headers.get("content-type") ?? "";
        buf = Buffer.from(await upstream.arrayBuffer());
      } catch (err: unknown) {
        console.warn("[client-mms-media] stored copy fetch threw", { id, error: err instanceof Error ? err.message : String(err) });
        res.status(502).json({ error: "media_unavailable" });
        return;
      }
    } else {
      console.warn("[client-mms-media] refused non-https media url", { id });
      res.status(404).json({ error: "not_found" });
      return;
    }
    ct = String(ct || "").split(";")[0]!.trim().toLowerCase();
    if (!ct || ct === "application/octet-stream") ct = guessMediaContentType(mediaUrl);
    if (!CLIENT_MEDIA_INLINE.test(ct)) {
      ct = "application/octet-stream";
      res.setHeader("Content-Disposition", "attachment");
    }
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).end(buf);
  }),
);

// BF_SERVER_v817_DIALER_MESSAGING - make sure a mini-portal application has a contact before its
// message is stored. Order: applications.contact_id -> application_contacts (applicant first, then
// oldest) -> a new contact from the signed-in client's phone + the applicant name in metadata (or the
// business name, or the formatted phone), in the application's silo. Links it to applications.contact_id.
// Returns null only when there is nothing to build a contact from (or the database failed - logged).
export async function ensureApplicationContactForMessage(applicationId: string, phone10: string): Promise<string | null> {
  try {
    const appRes = await dbQuery<{ contact_id: string | null; silo: string | null; metadata: any; business_legal_name: string | null; name: string | null }>(
      `SELECT contact_id, silo, metadata, business_legal_name, name FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId],
    );
    const app = appRes.rows[0];
    if (!app) return null;
    if (app.contact_id) {
      // BF_SERVER_v818_MERGED_CONTACT - a merged contact is archived with merged_into_id set; staff work on the
      // survivor, and the portal's Messages list skipped archived contacts, so the chat looked lost. Follow the
      // merge to the live survivor and repoint the application.
      const live = await dbQuery<{ id: string }>(
        `SELECT surv.id
           FROM contacts c
           JOIN contacts surv ON surv.id = c.merged_into_id
          WHERE c.id = $1::uuid
            AND coalesce(surv.status, 'active') <> 'archived'
            AND surv.merged_into_id IS NULL
          LIMIT 1`,
        [app.contact_id],
      );
      const survivor = live.rows[0]?.id ?? null;
      if (survivor) {
        await dbQuery(`UPDATE applications SET contact_id = $2::uuid WHERE id::text = ($1)::text`, [applicationId, survivor]);
        return survivor;
      }
      return app.contact_id;
    }

    let contactId: string | null = null;
    const linked = await dbQuery<{ contact_id: string }>(
      `SELECT contact_id FROM application_contacts
        WHERE application_id::text = ($1)::text
        ORDER BY (role = 'applicant') DESC, created_at ASC
        LIMIT 1`,
      [applicationId],
    );
    contactId = linked.rows[0]?.contact_id ?? null;

    if (!contactId) {
      const md = app.metadata && typeof app.metadata === "object" ? app.metadata : {};
      const a = md.applicant && typeof md.applicant === "object" ? md.applicant : {};
      const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
      const metaPhone10 = (str(a.phone) || str(md.applicant_phone) || str(md.readiness_phone)).replace(/[^0-9]/g, "").slice(-10);
      const p10 = phone10 && phone10.length === 10 ? phone10 : metaPhone10.length === 10 ? metaPhone10 : "";
      if (!p10) return null;
      let first = str(a.firstName) || str(a.first_name);
      let last = str(a.lastName) || str(a.last_name);
      if (!first && !last) {
        const full = str(a.name) || str(a.fullName) || str(md.applicant_name) || str(md.applicantName);
        if (full) { const parts = full.split(/\s+/); first = parts.shift() ?? ""; last = parts.join(" "); }
      }
      if (!first && !last) first = str(app.business_legal_name) || str(md.business?.legalName) || str(md.business?.businessName) || str(app.name);
      if (!first && !last) first = `(${p10.slice(0, 3)}) ${p10.slice(3, 6)}-${p10.slice(6)}`;
      const { createContact } = await import("../../services/contacts.js");
      const created = await createContact({ query: (t: string, p?: any[]) => dbQuery(t, p) } as any, {
        first_name: first,
        last_name: last,
        phone: `+1${p10}`,
        role: "applicant",
        is_primary_applicant: true,
        silo: app.silo || "BF",
      });
      contactId = created?.id ?? null;
    }
    if (contactId) {
      await dbQuery(
        `UPDATE applications SET contact_id = $2::uuid WHERE id::text = ($1)::text AND contact_id IS NULL`,
        [applicationId, contactId],
      );
    }
    return contactId;
  } catch (err: unknown) {
    logWarnSwallowed(err, "routes/client/index.ts:v817_ensure_contact", undefined);
    return null;
  }
}

router.post(
  "/messages",
  // BF_SERVER_v64_CLIENT_MSG_ENRICH — populate contact_id + silo from
  // applications so messages from the mini-portal land in the staff
  // portal Communications view (which filters by contact_id + silo).
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : null;
    // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — accept attachments from the
    // mini-portal (each ≤3MB, up to 5 per message).
    const rawAttach = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAttach
      .filter((a: any) => a && typeof a.name === "string" && typeof a.dataUrl === "string")
      .slice(0, 5)
      .map((a: any) => ({
        name: String(a.name).slice(0, 200),
        contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 80) : "application/octet-stream",
        dataUrl: String(a.dataUrl).slice(0, 4_500_000),
      }));
    if (!applicationId || (!body && attachments.length === 0)) {
      throw new AppError("validation_error", "applicationId and body or attachments are required.", 400);
    }

    // BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1 — before insert, backfill
    // applications.contact_id by phone digits-suffix if NULL. Without this the
    // mini-portal message lands with contact_id=NULL, and the staff Messages
    // tab silently drops it (it filters on contact_id presence). Result: the
    // client's send looked "dead" because staff never saw it.
    // BF_SERVER_v812_CLIENT_MSG_CONTACT_LINK - applications has no applicant_phone column, so the old
    // backfill failed on every message and never linked anything. Match on the signed-in client's phone
    // (or the phone captured at Step 1 in metadata.applicant_phone), preferring a contact in the
    // application's own silo, then the oldest one.
    const v812Principal = principalFromRequest(req);
    const v812Phone10 = v812Principal?.kind === "client"
      ? String(v812Principal.phone ?? "").replace(/[^0-9]/g, "").slice(-10)
      : "";
    await dbQuery(
      `UPDATE applications a
          SET contact_id = COALESCE((
                SELECT c.id
                  FROM contacts c
                 WHERE right(regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g'), 10)
                     = COALESCE(NULLIF($2::text, ''),
                                right(regexp_replace(coalesce(a.metadata->>'applicant_phone',''), '[^0-9]', '', 'g'), 10))
                   AND length(right(regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g'), 10)) = 10
                   -- BF_SERVER_v818_MERGED_CONTACT - never link to an archived / merged-away contact (oldest-first
                   -- picked the merge loser, so the chat landed on a contact the portal hides).
                   AND coalesce(c.status, 'active') <> 'archived'
                   AND c.merged_into_id IS NULL
                 ORDER BY (c.silo = a.silo) DESC, c.created_at ASC
                 LIMIT 1), a.contact_id)
        WHERE a.id::text = ($1)::text
          AND a.contact_id IS NULL`,
      [applicationId, v812Phone10]
    ).catch((err: unknown) => logWarnSwallowed(err, "routes/client/index.ts:v812_contact_link", undefined));

    // BF_SERVER_v817_DIALER_MESSAGING - the v812 phone link can still leave applications.contact_id
    // NULL (no contact with that phone yet), and the staff Messages list requires a contact, so the
    // message was invisible to staff. Fall back to the application's linked contact, then create one.
    const messageContactId = await ensureApplicationContactForMessage(applicationId, v812Phone10);

    const id = randomUUID();
    await dbQuery(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, attachments, created_at)
       VALUES (
         $1, 'message', 'inbound', 'received', $2,
         COALESCE($5::uuid, (SELECT contact_id FROM applications WHERE id = $2 LIMIT 1)),
         COALESCE((SELECT silo FROM applications WHERE id = $2 LIMIT 1), 'BF'),
         $3,
         CASE WHEN $4::text = '[]' THEN NULL ELSE $4::jsonb END,
         now()
       )`,
      [id, applicationId, body ?? "", JSON.stringify(attachments), messageContactId]
    );
    // BF_SERVER_BLOCK_v619 - automation trigger.
    void import("../../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent({ trigger: "message.inbound", applicationId, data: { channel: "client_portal" } })).catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
    // BF_SERVER_BLOCK_v496_MESSAGE_ATTACHMENTS_TO_DOCUMENTS - a file sent in chat is a document.
    if (attachments.length) {
      void import("../../services/communications/attachmentsToDocuments.js")
        .then(({ saveMessageAttachmentsAsDocuments }) => saveMessageAttachmentsAsDocuments({
          messageId: id, applicationId, attachments, uploadedBy: "client",
        }))
        .catch((err: any) => console.error("[client/messages] attachments to documents failed", err?.message ?? String(err)));
    }

    // v637: notify staff so client-to-staff messages aren't silent. Best-effort.
    try {
      const { sendStaffNotification } = await import("../../services/notifications/staffSms.js");
      void sendStaffNotification({
        recipients: "available",
        body: `Mini-portal message (app ${applicationId.slice(0,8)}): ${body.length > 140 ? body.slice(0,137) + "…" : body}`,
      }).catch(() => undefined);
    } catch { /* helper missing in some envs */ }

    // BF_SERVER_v820_WATCH_CALLS - bell + iPhone dialler + Watch alert (contact name + short preview). Detached and
    // never throws, so the client's send is never slowed or failed by it.
    void import("../../services/notifications/staffAlertEvents.js")
      .then((m) => m.alertClientMessage({ messageId: id, applicationId, contactId: messageContactId, body, attachmentCount: attachments.length }))
      .catch((err: any) => console.warn("[client/messages] staff alert failed", err?.message ?? String(err)));

    res.status(201).json({ status: "ok", data: { id } });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — mini-portal typing + mark-read
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    await dbQuery(
      `INSERT INTO messages_typing (contact_id, side, actor_label, updated_at)
       SELECT a.contact_id, 'client', NULL, NOW()
         FROM applications a
        WHERE a.id::text = $1
          AND a.contact_id IS NOT NULL
       ON CONFLICT (contact_id, side)
       DO UPDATE SET updated_at = NOW()`,
      [applicationId]
    ).catch((err: unknown) => logWarnSwallowed(err, "routes/client/index.ts:950", undefined));
    res.json({ ok: true });
  })
);

router.get(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query?.applicationId === "string" ? String(req.query.applicationId).trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    const r = await dbQuery<{ actor_label: string | null }>(
      `SELECT mt.actor_label
         FROM messages_typing mt
         JOIN applications a ON a.contact_id = mt.contact_id
        WHERE a.id::text = $1
          AND mt.side = 'staff'
          AND mt.updated_at > NOW() - INTERVAL '5 seconds'
        LIMIT 1`,
      [applicationId]
    ).catch((err: any) => { console.warn("[silent-query] routes/client/index.ts", { message: err?.message }); return { rows: [] as any[] }; });
    res.json({ typing: r.rows.length > 0, label: r.rows[0]?.actor_label ?? null });
  })
);

router.post(
  "/messages/mark-read",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    const r = await dbQuery(
      `UPDATE communications_messages
          SET read_at = NOW()
        WHERE type = 'message'
          AND direction = 'outbound'
          AND read_at IS NULL
          AND application_id::text = $1`,
      [applicationId]
    ).catch((err: unknown) => logWarnSwallowed(err, "routes/client/index.ts:988", ({ rowCount: 0 })));
    res.json({ ok: true, updated: (r as any).rowCount ?? 0 });
  })
);

export default router;
