import { randomUUID } from "node:crypto";
import { Router } from "express";
import { pool, runQuery } from "../db.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { eventBus } from "../events/eventBus.js";
// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — AUDIT-11 regression repair: stop
// public reads/writes on /api/offers, /api/offers/:id/status.
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();

router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // Pre-fix, this returned offers for any application id (or the top 100
    // across silos when no filter was given). Match the portal silo
    // contract: filter by the caller's resolved silo, joining offers
    // through applications.silo. NULL applications.silo is treated as
    // belonging to the caller's silo so legacy un-tagged rows remain
    // accessible.
    const { getSilo } = await import("../middleware/silo.js");
    const callerSilo = getSilo(res) ?? null;
    const query = applicationId
      ? {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where o.application_id = $1
                   and ($2::text is null or a.silo is null or a.silo = $2::text)
                 order by o.updated_at desc`,
          values: [applicationId, callerSilo],
        }
      : {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where ($1::text is null or a.silo is null or a.silo = $1::text)
                 order by o.updated_at desc
                 limit 100`,
          values: [callerSilo],
        };
    const rows = await runQuery(query.text, query.values);
    res.status(200).json({ items: rows.rows });
  })
);

router.post(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lender = typeof req.body?.lender === "string" ? req.body.lender.trim() : "";
    if (!applicationId || !lender) {
      throw new AppError("validation_error", "applicationId and lender are required.", 400);
    }
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // Without this guard, staff in any silo could create an offer record
    // attached to an application in any other silo by knowing the UUID.
    // 404 rather than 403 to avoid leaking that the application exists in
    // another silo. Pattern mirrors v309 portal handlers.
    {
      const { getSilo } = await import("../middleware/silo.js");
      const callerSilo = getSilo(res);
      const owner = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId]
      );
      if (!owner.rows[0]) {
        throw new AppError("not_found", "Application not found.", 404);
      }
      const recordSilo = owner.rows[0].silo;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }

    const result = await runQuery(
      `insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created',$11,now(),now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [
        randomUUID(),
        applicationId,
        lender,
        req.body?.amount ?? null,
        req.body?.rate ?? null,
        req.body?.term ?? null,
        req.body?.payment_frequency ?? null,
        req.body?.expiry ?? null,
        req.body?.pdf ?? null,
        false,
        typeof req.body?.notes === "string" ? req.body.notes : null,
      ]
    );

    const offer = result.rows[0];
    if (!offer) {
      throw new AppError("create_failed", "Offer could not be created.", 500);
    }
    eventBus.emit("offer_created", { offerId: offer.id, applicationId });
    res.status(201).json({ offer });
  })
);

router.patch(
  "/:id/status",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
      throw new AppError("validation_error", "Valid status is required.", 400);
    }
    // BF_SERVER_BLOCK_v314_OFFERS_SILO_ENFORCEMENT_v1
    // PATCH /:id/status emits offer_accepted when status='accepted', which
    // has downstream side effects on the application (offer-acceptance
    // listener transitions pipeline_state). Without this guard, staff in
    // any silo could flip an offer's status on any application by knowing
    // the offer UUID. Use a JOIN-style WHERE so the WHERE clause itself
    // enforces silo, eliminating a separate guard query.
    const { getSilo } = await import("../middleware/silo.js");
    const callerSilo = getSilo(res) ?? null;

    const updated = await runQuery(
      `update offers
          set status = $2, updated_at = now()
        where id = $1
          and exists (
            select 1 from applications a
             where a.id::text = offers.application_id::text
               and ($3::text is null or a.silo is null or a.silo = $3::text)
          )
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [id, status, callerSilo]
    );
    const offer = updated.rows[0];
    if (!offer) throw new AppError("not_found", "Offer not found.", 404);

    if (status === "accepted") {
      eventBus.emit("offer_accepted", { offerId: id, applicationId: offer.application_id });
    }
    res.status(200).json({ offer });
  })
);

export default router;
