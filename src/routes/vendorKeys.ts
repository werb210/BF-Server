// BF_SERVER_v898_YOUR_SERVICES - /api/vendor-keys (Admin): Boreal's own verification-service keys.
//   GET  which are set (secrets show only their last 4 characters), sign-up links, the Onfido webhook address
//   PUT  { values: { NAME: "value" | null } }  a string sets it, null or "" removes it
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { loadVendorKeys, saveVendorKeys, sealingKey, startVendorKeyRefresher, VENDOR_SERVICES, VendorKeyError, viewOf } from "../integrations/vendorKeys.js";

const router = Router();
router.use(requireAuth);

const isAdmin = (req: any) => String(req.user?.role ?? "").toUpperCase() === "ADMIN";

if (process.env.NODE_ENV !== "test") startVendorKeyRefresher(pool as any);

router.get("/", safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin_only" });
  res.setHeader("Cache-Control", "no-store");
  const values = await loadVendorKeys(pool as any);
  const base = String(process.env.PUBLIC_BASE_URL ?? "https://server.boreal.financial").replace(/\/+$/, "");
  res.json({ services: VENDOR_SERVICES, keys: viewOf(values), onfido_webhook_url: base + "/api/kyc/webhooks/onfido", can_save: Boolean(sealingKey()) });
}));

router.put("/", safeHandler(async (req: any, res: any) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "admin_only" });
  const values = req.body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return res.status(400).json({ error: "values_required" });
  try {
    const saved = await saveVendorKeys(pool as any, values as Record<string, unknown>, String(req.user?.id ?? req.user?.userId ?? "") || null);
    console.info({ event: "vendor_keys_saved", keys: Object.keys(values) });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, keys: viewOf(saved) });
  } catch (err) {
    if (err instanceof VendorKeyError) return res.status(err.code === "no_encryption_key" ? 503 : 400).json({ error: err.code });
    throw err;
  }
}));

export default router;
