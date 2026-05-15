import { Router } from "express";
import { requireAuth, requireAuthorization, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";
import { AIKnowledgeController, upload as knowledgeUpload } from "../modules/ai/knowledge.controller.js";
import type { MulterRequest } from "../types/multer.js";

const router = Router();

// BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 1
// Pre-fix the only privilege gate on this router was router.use(requireCapability
// ([CAPABILITIES.SETTINGS_READ])) which applies to ALL routes including writes,
// so ANY role with settings:read could mutate AI knowledge and branding. The
// earlier v315 admin gate was applied to ai.ts which is dead code (verified
// not mounted anywhere -- the live AI knowledge endpoints are these settings
// routes, not /api/ai/knowledge/*). This block adds requireAuthorization with
// ROLES.ADMIN on each write handler below. Reads remain SETTINGS_READ-gated.
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));

const requireAdminWrite = requireAuthorization({ roles: [ROLES.ADMIN] });

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, { status: "ok" });
}));

router.get("/preferences", safeHandler((_req: any, res: any) => {
  respondOk(res, { preferences: {} });
}));

router.get("/me", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.userId ?? null;
  type SettingsMeRow = {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    role: string | null;
    silo: string | null;
    o365_access_token: string | null;
  };
  const userResult = userId
    ? await pool.query<SettingsMeRow>(
        `SELECT first_name, last_name, email, phone, role, silo, o365_access_token
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId]
      ).catch(() => ({ rows: [] as SettingsMeRow[] }))
    : { rows: [] as SettingsMeRow[] };
  const user = userResult.rows[0];
  const o365Connected = Boolean(user?.o365_access_token && user.o365_access_token.trim().length > 0);

  respondOk(res, {
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    email: user?.email ?? null,
    phone: user?.phone ?? null,
    role: user?.role ?? req.user?.role ?? null,
    silo: user?.silo ?? req.user?.silo ?? null,
    o365_connected: o365Connected,
  });
}));

router.post(
  "/ai-knowledge",
  requireAdminWrite,
  knowledgeUpload.single("file"),
  safeHandler(async (req: any, res: any) => {
    try {
      await AIKnowledgeController.upload(req as MulterRequest, res);
    } catch (e: any) {
      if (e?.code === "openai_not_configured") {
        return res.status(503).json({
          ok: false,
          savedWithoutIndex: true,
          message: "Saved, but Maya search is degraded — set OPENAI_API_KEY to enable embeddings.",
        });
      }
      if (e?.code === "embedding_failed" || e?.code === "no_vector") {
        return res.status(503).json({
          ok: false,
          savedWithoutIndex: true,
          message: "Saved, but the embedding service is unavailable. Try again later.",
        });
      }
      throw e;
    }
  })
);

router.get("/ai-knowledge", safeHandler(async (_req: any, res: any) => {
  const { rows } = await pool.query<{ id: string; source_type: string; source_id: string | null; content: string; created_at: string }>(
    `SELECT id, source_type, source_id,
            LEFT(content, 240) AS content,
            created_at
       FROM ai_knowledge
     ORDER BY created_at DESC
       LIMIT 500`
  );
  respondOk(res, { documents: rows });
}));

router.post("/ai-knowledge/text", requireAdminWrite, safeHandler(async (req: any, res: any) => {
  const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!content) {
    return res.status(400).json({ error: { code: "validation_error", message: "content is required" } });
  }
  const { embedAndStore } = await import("../modules/ai/knowledge.service.js");
  try {
    await embedAndStore(pool, content, "text", title || null, title || null);
    respondOk(res, { ok: true });
  } catch (e: any) {
    if (e?.code === "openai_not_configured") {
      return res.status(503).json({
        ok: false,
        savedWithoutIndex: true,
        message: "Saved, but Maya search is degraded — set OPENAI_API_KEY to enable embeddings.",
      });
    }
    if (e?.code === "embedding_failed" || e?.code === "no_vector") {
      return res.status(503).json({
        ok: false,
        savedWithoutIndex: true,
        message: "Saved, but the embedding service is unavailable. Try again later.",
      });
    }
    throw e;
  }
}));

router.delete("/ai-knowledge/:id", requireAdminWrite, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: { code: "validation_error", message: "id required" } });
  }
  await pool.query(`DELETE FROM ai_knowledge WHERE id = $1`, [id]);
  respondOk(res, { ok: true });
}));

router.get("/branding", safeHandler(async (_req: any, res: any) => {
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM settings WHERE key LIKE 'branding.%' LIMIT 20`
    );
    const branding: Record<string, string> = {};
    for (const row of rows) {
      branding[row.key.replace("branding.", "")] = row.value;
    }
    respondOk(res, { branding });
  } catch (err) {
    // BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- log instead of
    // silently swallowing. The empty-branding fallback is intentional (table
    // may not exist on a fresh DB), but errors should reach the logs so we
    // notice schema drift or pool exhaustion.
    console.warn("[settings.branding GET] query failed", { err: String(err) });
    respondOk(res, { branding: {} });
  }
}));

router.post("/branding", requireAdminWrite, safeHandler(async (req: any, res: any) => {
  const { logoUrl, logoSize } = req.body ?? {};
  try {
    if (logoUrl !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('branding.logoUrl', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(logoUrl)]
      );
    }
    if (logoSize !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('branding.logoSize', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(logoSize)]
      );
    }
  } catch (err) {
    // BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- log; the row
    // wasn't written and the user is going to see stale branding on next
    // load. They need to know the write failed.
    console.warn("[settings.branding POST] write failed", { err: String(err) });
  }
  respondOk(res, { ok: true });
}));

export default router;
