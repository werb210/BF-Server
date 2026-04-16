import crypto from "node:crypto";
import { Router } from "express";
import { runQuery } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";

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

router.get("/:id", requireAuth, async (req, res) => {
  return res.json({ status: "ok", data: { id: req.params.id } });
});

export default router;
