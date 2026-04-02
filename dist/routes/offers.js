"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const eventBus_1 = require("../events/eventBus");
const router = (0, express_1.Router)();
router.get("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
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
    const rows = await (0, db_1.runQuery)(query.text, query.values);
    res.status(200).json({ items: rows.rows });
}));
router.post("/", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lender = typeof req.body?.lender === "string" ? req.body.lender.trim() : "";
    if (!applicationId || !lender) {
        throw new errors_1.AppError("validation_error", "applicationId and lender are required.", 400);
    }
    const result = await (0, db_1.runQuery)(`insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'created',$11,now(),now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`, [
        (0, crypto_1.randomUUID)(),
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
    ]);
    const offer = result.rows[0];
    eventBus_1.eventBus.emit("offer_created", { offerId: offer.id, applicationId });
    res.status(201).json({ offer });
}));
router.patch("/:id/status", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
        throw new errors_1.AppError("validation_error", "Valid status is required.", 400);
    }
    const updated = await (0, db_1.runQuery)(`update offers set status = $2, updated_at = now()
       where id = $1
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`, [id, status]);
    const offer = updated.rows[0];
    if (!offer)
        throw new errors_1.AppError("not_found", "Offer not found.", 404);
    if (status === "accepted") {
        eventBus_1.eventBus.emit("offer_accepted", { offerId: id, applicationId: offer.application_id });
    }
    res.status(200).json({ offer });
}));
exports.default = router;
