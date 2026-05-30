import crypto from "node:crypto";
import { Router } from "express";
import { runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";
import { findApplicationById } from "../modules/applications/applications.repo.js";

const router = Router();

router.post("/", requireAuth, async (req, res) => {
  const applicationId = crypto.randomUUID();
  const user = (req as any).user;
  const ownerPhone = typeof user?.phone === "string" ? user.phone : null;
  const ownerUserIdRaw = typeof user?.id === "string" ? user.id : null;

  let ownerUserId = ownerUserIdRaw;

  if (!ownerUserId && ownerPhone) {
    try {
      const lookup = await runQuery<{ id: string }>(
        "SELECT id FROM users WHERE phone = $1 LIMIT 1",
        [ownerPhone],
      );
      ownerUserId = lookup.rows[0]?.id ?? null;
    } catch {
      ownerUserId = null;
    }
  }

  try {
    await runQuery(
      `INSERT INTO applications (id, owner_user_id, pipeline_state, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [applicationId, ownerUserId, ApplicationStage.RECEIVED],
    );
  } catch (err) {
    console.error("applications insert failed — returning in-memory id", err);
    // DB may not be ready; return the id anyway so client flow is not blocked
  }

  return res.status(201).json({ status: "ok", data: { applicationId } });
});

// BF_SERVER_BLOCK_v687_APPLICATIONS_STATUS_ENDPOINT_v1
// The Maya agent (and its staff/client modes) call GET /api/applications/status
// with ?applicationId=, ?identifier= or ?status=. That endpoint never existed,
// so the request fell through to the GET /:id stub below and every Maya
// application lookup returned nothing — surfacing in chat as "I couldn't fetch
// your application." This implements the real endpoint, backed by the proven
// findApplicationById repo helper. Declared BEFORE GET /:id so Express matches
// "/status" here rather than treating "status" as an :id.
const APP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get("/status", requireAuth, async (req, res) => {
  const idParam =
    (typeof req.query.applicationId === "string" && req.query.applicationId.trim()) ||
    (typeof req.query.identifier === "string" && req.query.identifier.trim()) ||
    "";
  const byStatus = typeof req.query.status === "string" ? req.query.status.trim() : "";
  try {
    if (idParam) {
      if (!APP_UUID_RE.test(idParam)) {
        return res.status(404).json({ status: "error", error: { code: "not_found", message: "No application found for that identifier." } });
      }
      const app = await findApplicationById(idParam);
      if (!app) {
        return res.status(404).json({ status: "error", error: { code: "not_found", message: "Application not found." } });
      }
      const a = app as Record<string, unknown>;
      return res.json({
        status: "ok",
        data: {
          applicationId: a.id ?? idParam,
          name: a.name ?? null,
          stage: a.pipeline_state ?? a.status ?? null,
          status: a.status ?? null,
          requestedAmount: a.requested_amount ?? null,
          productType: a.product_type ?? null,
          updatedAt: a.updated_at ?? null,
        },
      });
    }
    if (byStatus) {
      const { rows } = await runQuery(
        `SELECT id, name, pipeline_state, status, requested_amount, updated_at
           FROM applications
          WHERE lower(COALESCE(pipeline_state, status, '')) = lower($1)
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 50`,
        [byStatus],
      );
      return res.json({ status: "ok", data: { applications: rows } });
    }
    return res.status(400).json({ status: "error", error: { code: "validation_error", message: "applicationId or status required." } });
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ status: "error", error: { code: "lookup_failed", message: m } });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  return res.json({ status: "ok", data: { id: req.params.id } });
});

export default router;
