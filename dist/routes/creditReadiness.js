"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../db");
const config_1 = require("../config");
const pipelineState_1 = require("../modules/applications/pipelineState");
const sms_service_1 = require("../modules/notifications/sms.service");
const continuation_1 = require("../models/continuation");
const readinessSession_service_1 = require("../modules/readiness/readinessSession.service");
const leadUpsert_service_1 = require("../modules/crm/leadUpsert.service");
const retry_1 = require("../utils/retry");
const logger_1 = require("../observability/logger");
const router = (0, express_1.Router)();
const payloadSchema = zod_1.z.object({
    companyName: zod_1.z.string().min(1),
    fullName: zod_1.z.string().min(1),
    phone: zod_1.z.string().min(1),
    email: zod_1.z.string().email(),
    industry: zod_1.z.string().optional(),
    yearsInBusiness: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
    monthlyRevenue: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
    annualRevenue: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
    arOutstanding: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
    existingDebt: zod_1.z.union([zod_1.z.string(), zod_1.z.boolean()]).optional(),
});
router.post("/", async (req, res, next) => {
    const parsed = payloadSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload" });
        return;
    }
    const { companyName, fullName, phone, email, industry, yearsInBusiness, monthlyRevenue, annualRevenue, arOutstanding, existingDebt, } = parsed.data;
    const applicationId = (0, node_crypto_1.randomUUID)();
    await db_1.db.query(`
      insert into applications
      (id, owner_user_id, name, metadata, product_type, pipeline_state, status, source, created_at, updated_at)
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now(), now())
    `, [
        applicationId,
        config_1.config.client.submissionOwnerUserId,
        companyName,
        JSON.stringify({
            contactName: fullName,
            phone,
            email,
            industry: industry ?? null,
            yearsInBusiness: yearsInBusiness ?? null,
            monthlyRevenue: monthlyRevenue ?? null,
            annualRevenue: annualRevenue ?? null,
            arOutstanding: arOutstanding ?? null,
            existingDebt: existingDebt ?? null,
        }),
        "standard",
        pipelineState_1.ApplicationStage.RECEIVED,
        pipelineState_1.ApplicationStage.RECEIVED,
        "website_credit_readiness",
    ]);
    const crmLead = await (0, leadUpsert_service_1.upsertCrmLead)({
        companyName,
        fullName,
        phone,
        email,
        industry,
        yearsInBusiness,
        monthlyRevenue,
        annualRevenue,
        arOutstanding,
        existingDebt,
        source: "website_credit_readiness",
        tags: ["readiness"],
        activityType: "credit_readiness_submission",
        activityPayload: { applicationId },
    });
    const readinessSession = await (0, readinessSession_service_1.createOrReuseReadinessSession)({
        companyName,
        fullName,
        phone,
        email,
        industry,
        yearsInBusiness,
        monthlyRevenue,
        annualRevenue,
        arOutstanding,
        existingDebt,
    });
    const continuationToken = await (0, continuation_1.createContinuation)(applicationId);
    await (0, retry_1.retry)(() => (0, sms_service_1.sendSms)({
        to: "+15878881837",
        message: `Credit Readiness: ${fullName} | ${phone} | ${industry ?? "N/A"} | Monthly ${monthlyRevenue ?? "N/A"} / Annual ${annualRevenue ?? "N/A"}`,
    }), 2).catch((error) => {
        (0, logger_1.logError)("credit_readiness_sms_failed", {
            message: error instanceof Error ? error.message : String(error),
            email,
        });
    });
    res["json"]({
        success: true,
        continuationToken,
        sessionId: readinessSession.sessionId,
        token: readinessSession.token,
        crmLeadId: crmLead.id,
    });
});
exports.default = router;
