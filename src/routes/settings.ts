import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
import { pool } from "../db.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, { status: "ok" });
}));

router.get("/preferences", safeHandler((_req: any, res: any) => {
  respondOk(res, { preferences: {} });
}));

router.get("/me", safeHandler((req: any, res: any) => {
  respondOk(res, {
    userId: req.user?.userId ?? null,
    role: req.user?.role ?? null,
    phone: req.user?.phone ?? null,
  });
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
