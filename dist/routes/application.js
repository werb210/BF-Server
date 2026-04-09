import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { createApplication } from "../modules/applications/applications.repo.js";
import { config } from "../config/index.js";
import { fail, ok } from "../lib/apiResponse.js";
import { validate } from "../middleware/validate.js";
import { wrap } from "../lib/routeWrap.js";
const router = Router();
const createApplicationSchema = z.object({
    sessionId: z.string().uuid(),
    source: z.string().trim().optional(),
});
router.get("/update", wrap(async () => ok({})));
router.post("/update", wrap(async () => ok({})));
function enforceSubmitPayload(req, res, next) {
    if (!req.body?.businessType || !req.body?.applicantName) {
        return next(new Error("INVALID_APPLICATION_PAYLOAD"));
    }
    return next();
}
async function handleApplicationSubmit(req, res) {
    const { sessionId, source } = req.validated;
    const mapped = await db.query(`select application_id from readiness_application_mappings where readiness_session_id = $1 limit 1`, [sessionId]);
    if (mapped.rows[0]?.application_id) {
        return ok({ applicationId: mapped.rows[0].application_id, reused: true });
    }
    const session = await db.query(`select id, crm_lead_id, company_name, full_name, email, phone, industry, years_in_business,
              monthly_revenue, annual_revenue, ar_outstanding, existing_debt
       from readiness_sessions where id = $1 limit 1`, [sessionId]);
    const readiness = session.rows[0];
    if (!readiness) {
        return fail(res, "readiness_session_not_found");
    }
    const created = await createApplication({
        ownerUserId: config.client.submissionOwnerUserId,
        name: readiness.company_name,
        metadata: {
            readinessSessionId: readiness.id,
            crmLeadId: readiness.crm_lead_id,
            readiness: {
                fullName: readiness.full_name,
                email: readiness.email,
                phone: readiness.phone,
                industry: readiness.industry,
                yearsInBusiness: readiness.years_in_business,
                monthlyRevenue: readiness.monthly_revenue,
                annualRevenue: readiness.annual_revenue,
                arOutstanding: readiness.ar_outstanding,
                existingDebt: readiness.existing_debt,
            },
        },
        productType: "standard",
        productCategory: "standard",
        source: source ?? "readiness_continuation",
    });
    await db.query(`insert into readiness_application_mappings (id, readiness_session_id, application_id)
       values ($1, $2, $3)
       on conflict (readiness_session_id) do nothing`, [randomUUID(), readiness.id, created.id]);
    await db.query(`update readiness_sessions
       set converted_application_id = $2, is_active = false, updated_at = now()
       where id = $1`, [readiness.id, created.id]);
    return ok({ applicationId: created.id, leadId: readiness.crm_lead_id, reused: false });
}
router.post("/", validate(createApplicationSchema), wrap(handleApplicationSubmit));
router.post("/submit", enforceSubmitPayload, validate(createApplicationSchema), wrap(handleApplicationSubmit));
export default router;
