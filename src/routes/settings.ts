import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";
import { AIKnowledgeController, upload as knowledgeUpload } from "../modules/ai/knowledge.controller.js";
import type { MulterRequest } from "../types/multer.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));

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
  knowledgeUpload.single("file"),
  safeHandler(async (req: any, res: any) => {
    await AIKnowledgeController.upload(req as MulterRequest, res);
  })
);

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
  } catch {
    respondOk(res, { branding: {} });
  }
}));

router.post("/branding", safeHandler(async (req: any, res: any) => {
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
  } catch {
    // settings table may not exist — ignore
  }
  respondOk(res, { ok: true });
}));

export default router;
