import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbQuery } from "../db.js";
import { createApplication } from "../modules/applications/applications.repo.js";
import { config } from "../config/index.js";
import { fail, ok } from "../lib/apiResponse.js";
import { wrap } from "../lib/routeWrap.js";
import { getSilo } from "../middleware/silo.js";

const router = Router();

const StartSchema = z.object({
  sessionId: z.string().uuid().optional(),
  source:    z.string().trim().optional(),
});

/**
 * POST /api/public/application/start
 * Converts a readiness session into an application. Public by design — the sessionId
 * is the bearer credential. If no sessionId is given, creates a blank application
 * stub that the wizard then patches via PATCH /api/client/applications/:id.
 */
router.post(
  "/application/start",
  wrap(async (req, res) => {
    // BF_START_PHASE_GUARD_v20 — Block 20 timeout + lifecycle phase logging.
    // BF_PUBAPP_RES_WRITE_v32 — Block 32: handler must write res.json(), not just return ok().
    const startedAt = Date.now();
    let phase = "received";
    const setPhase = (nextPhase: string) => {
      phase = nextPhase;
      // eslint-disable-next-line no-console
      console.log(`[start.phase] ${nextPhase} +${Date.now() - startedAt}ms`);
    };
    const timeoutMs = Number(process.env.BF_START_TIMEOUT_MS || 15000);
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      // eslint-disable-next-line no-console
      console.error(`[start.timeout] hung at phase=${phase} after ${timeoutMs}ms`);
      res.status(504).json({
        status: "error",
        error: "start_handler_timeout",
        last_phase: phase,
        elapsed_ms: Date.now() - startedAt,
      });
    }, timeoutMs);

    try {
      setPhase("parse_input");
      const parsed = StartSchema.safeParse(req.body ?? {});
      if (!parsed.success) { res.status(400).json(fail(res, "INVALID_INPUT")); return; }
      const { sessionId, source } = parsed.data;
      const silo = getSilo(res);

      if (sessionId) {
        setPhase("lookup_mapping");
        const mapped = await dbQuery<{ application_id: string }>(
          `SELECT application_id FROM readiness_application_mappings WHERE readiness_session_id = $1 LIMIT 1`,
          [sessionId]
        );
        if (mapped.rows[0]?.application_id) {
          setPhase("mapped_reuse");
          res.status(200).json(ok({ applicationId: mapped.rows[0].application_id, reused: true })); return;
        }

        setPhase("load_readiness_session");
        const session = await dbQuery<any>(
          `SELECT id, crm_lead_id, company_name, full_name, email, phone, industry, years_in_business,
                  monthly_revenue, annual_revenue, ar_outstanding, existing_debt
           FROM readiness_sessions WHERE id = $1 LIMIT 1`,
          [sessionId]
        );
        const r = session.rows[0];
        if (!r) { res.status(400).json(fail(res, "readiness_session_not_found")); return; }

        setPhase("create_application");
        const created = await createApplication({
          ownerUserId: (config.client.submissionOwnerUserId || "00000000-0000-0000-0000-000000000001"),
          name: r.company_name,
          metadata: {
            readinessSessionId: r.id,
            crmLeadId: r.crm_lead_id,
            readiness: {
              fullName: r.full_name, email: r.email, phone: r.phone,
              industry: r.industry, yearsInBusiness: r.years_in_business,
              monthlyRevenue: r.monthly_revenue, annualRevenue: r.annual_revenue,
              arOutstanding: r.ar_outstanding, existingDebt: r.existing_debt,
            },
          },
          productType: "standard",
          productCategory: "standard",
          source: source ?? "readiness_continuation",
          silo,
        } as any);

        setPhase("insert_mapping");
        await dbQuery(
          `INSERT INTO readiness_application_mappings (id, readiness_session_id, application_id)
           VALUES ($1, $2, $3) ON CONFLICT (readiness_session_id) DO NOTHING`,
          [randomUUID(), r.id, created.id]
        );
        setPhase("close_readiness_session");
        await dbQuery(
          `UPDATE readiness_sessions SET converted_application_id=$2, is_active=false, updated_at=now() WHERE id=$1`,
          [r.id, created.id]
        );
        setPhase("done");
        res.status(200).json(ok({ applicationId: created.id, leadId: r.crm_lead_id, reused: false })); return;
      }

      // No readiness session — just mint a blank application the wizard can PATCH.
      setPhase("create_blank_application");
      const created = await createApplication({
        ownerUserId: (config.client.submissionOwnerUserId || "00000000-0000-0000-0000-000000000001"),
        name: "Draft application",
        metadata: {},
        productType: "standard",
        productCategory: "standard",
        source: source ?? "client_direct",
        silo,
      } as any);
      setPhase("done");
      res.status(200).json(ok({ applicationId: created.id, reused: false })); return;
    } finally {
      clearTimeout(timer);
    }
  })
);

export default router;
