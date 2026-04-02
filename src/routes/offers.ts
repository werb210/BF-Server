import { randomUUID } from "crypto";
import { Router } from "express";
import { pool, runQuery } from "../db";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";
import { eventBus } from "../events/eventBus";

const router = Router();

router.get(
  "/",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
    const query = applicationId
      ? {
          text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers where application_id = $1 order by updated_at desc`,
          values: [applicationId],
        }
      : {
          text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers order by updated_at desc limit 100`,
          values: [],
        };
    const rows = await runQuery(query.text, query.values);
    res.status(200).json({ items: rows.rows });
  })
);

router.post(
  "/",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lender = typeof req.body?.lender === "string" ? req.body.lender.trim() : "";
    if (!applicationId || !lender) {
      throw new AppError("validation_error", "applicationId and lender are required.", 400);
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
    eventBus.emit("offer_created", { offerId: offer.id, applicationId });
    res.status(201).json({ offer });
  })
);

router.patch(
  "/:id/status",
  safeHandler(async (req: any, res: any, next: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
      throw new AppError("validation_error", "Valid status is required.", 400);
    }

    const updated = await runQuery(
      `update offers set status = $2, updated_at = now()
       where id = $1
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [id, status]
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
