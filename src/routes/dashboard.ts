import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { respondOk } from "../utils/respondOk";
import { pool } from "../db";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.STAFF_OVERVIEW]));

router.get(
  "/",
  safeHandler(async (_req, res) => {
    try {
      const [pipeline, docs, submissions, offers] = await Promise.all([
      pool.query<{
        new_count: number;
        in_review_count: number;
        requires_docs_count: number;
        sent_to_lender_count: number;
        offers_received_count: number;
        closed_count: number;
        declined_count: number;
      }>(`select
            count(*) filter (where pipeline_state in ('received', 'new'))::int as new_count,
            count(*) filter (where pipeline_state in ('in_review','underwriting'))::int as in_review_count,
            count(*) filter (where pipeline_state in ('docs_required', 'missing_docs'))::int as requires_docs_count,
            count(*) filter (where pipeline_state in ('off_to_lender','submitted_to_lender'))::int as sent_to_lender_count,
            count(*) filter (where pipeline_state in ('offer_received','offers_received'))::int as offers_received_count,
            count(*) filter (where status in ('closed','funded'))::int as closed_count,
            count(*) filter (where status in ('declined','rejected'))::int as declined_count
         from applications`),
      pool.query<{ missing_docs: number; rejected_docs: number }>(
        `select
          count(*) filter (where status = 'missing')::int as missing_docs,
          count(*) filter (where status = 'rejected')::int as rejected_docs
         from documents`
      ),
      pool.query<{
        id: string;
        application_id: string;
        status: string;
        created_at: string;
      }>(
        `select id, application_id, status, created_at::text
         from lender_submissions
         order by created_at desc
         limit 10`
      ),
      pool.query<{
        id: string;
        application_id: string;
        status: string;
        lender_name: string;
        amount: string | null;
        updated_at: string;
      }>(
        `select id, application_id, status, lender_name, amount::text, updated_at::text
         from offers
         order by updated_at desc
         limit 10`
      ),
    ]);

    const summary = pipeline.rows[0] ?? {
      new_count: 0,
      in_review_count: 0,
      requires_docs_count: 0,
      sent_to_lender_count: 0,
      offers_received_count: 0,
      closed_count: 0,
      declined_count: 0,
    };

      respondOk(res, {
      pipelineOverview: {
        newApplications: summary.new_count,
        inReview: summary.in_review_count,
        requiresDocs: summary.requires_docs_count,
        sentToLender: summary.sent_to_lender_count,
        offersReceived: summary.offers_received_count,
        closed: summary.closed_count,
        declined: summary.declined_count,
      },
      urgentActions: {
        requiresDocs: summary.requires_docs_count,
      },
      documentHealth: {
        missing: docs.rows[0]?.missing_docs ?? 0,
        rejected: docs.rows[0]?.rejected_docs ?? 0,
      },
      lenderSubmissions: submissions.rows,
      offerActivity: offers.rows,
      dealMetrics: {
        activeDeals:
          summary.new_count +
          summary.in_review_count +
          summary.requires_docs_count +
          summary.sent_to_lender_count,
      },
      });
    } catch {
      respondOk(res, {
        pipelineOverview: {
          newApplications: 0,
          inReview: 0,
          requiresDocs: 0,
          sentToLender: 0,
          offersReceived: 0,
          closed: 0,
          declined: 0,
        },
        urgentActions: { requiresDocs: 0 },
        documentHealth: { missing: 0, rejected: 0 },
        lenderSubmissions: [],
        offerActivity: [],
        dealMetrics: { activeDeals: 0 },
      });
    }
  })
);

export default router;
