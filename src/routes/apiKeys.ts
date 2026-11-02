// BF_SERVER_v875_API_KEYS (ported from KS-server #35, plan gate removed) - Admins create, change, list and revoke API
// keys. Keys follow the topbar silo: a key made in BI reads and writes only BI records. Mounted at /api/api-keys.
//   GET    /api/api-keys         { ok, data: { keys, scopes } }  name, silo, permissions, prefix, limit, created, last used
//   POST   /api/api-keys         { name, scopes: [...], rate_limit_per_minute? } -> { ok, data: { key, secret } }
//                                (the secret is shown once)
//   PATCH  /api/api-keys/:id     { name?, scopes?, rate_limit_per_minute? }  (the key itself does not change)
//   DELETE /api/api-keys/:id     revoke (it stops working at once)
// Every change is written to the audit log.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import {
  API_SCOPES, DEFAULT_RATE_LIMIT, MAX_ACTIVE_KEYS, MAX_RATE_LIMIT, SCOPE_LABELS, countActiveKeys, currentPepper, generateApiKey,
  insertApiKey, listApiKeys, normalizeScopes, parseRateLimit, revokeApiKey, updateApiKey,
} from "../apiKeys/keys.js";

const router = Router();
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN] }));
const db = () => pool as unknown as Q;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanName(raw: unknown): string | null {
  const name = String(raw ?? "").trim();
  return name && name.length <= 80 ? name : null;
}

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    ok: true,
    data: {
      silo,
      keys: await listApiKeys(db(), silo),
      scopes: API_SCOPES.map((s) => ({ scope: s, label: SCOPE_LABELS[s] })),
      limits: { active_keys: MAX_ACTIVE_KEYS, default_rate_limit: DEFAULT_RATE_LIMIT, max_rate_limit: MAX_RATE_LIMIT },
      configured: currentPepper() !== null,
    },
  });
}));

router.post("/", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const name = cleanName(req.body?.name);
  if (!name) return res.status(400).json({ ok: false, error: "invalid_name", message: "Give the key a name (80 characters at most)." });
  const scopes = normalizeScopes(req.body?.scopes);
  if (!scopes.ok) return res.status(400).json({ ok: false, error: "invalid_scopes", message: scopes.error });
  const limit = parseRateLimit(req.body?.rate_limit_per_minute);
  if (!limit.ok) return res.status(400).json({ ok: false, error: "invalid_rate_limit", message: limit.error });
  const pepper = currentPepper();
  if (!pepper) return res.status(503).json({ ok: false, error: "api_keys_not_configured", message: "API keys are not set up on this server yet." });
  if ((await countActiveKeys(db(), silo)) >= MAX_ACTIVE_KEYS) {
    return res.status(409).json({ ok: false, error: "too_many_keys", message: `You can have ${MAX_ACTIVE_KEYS} active keys in a silo. Revoke one you no longer use first.` });
  }
  const k = generateApiKey(pepper);
  const key = await insertApiKey(db(), k, { name, silo, scopes: scopes.scopes, rateLimit: limit.value, by: actorId(req) });
  await auditFor(req, "api_key_created", { name, silo, scopes: scopes.scopes, rate_limit_per_minute: limit.value, key_prefix: key.key_prefix }, { type: "api_key", id: key.id });
  res.setHeader("Cache-Control", "no-store");
  res.status(201).json({ ok: true, data: { key, secret: k.key } });
}));

router.patch("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found", message: "No active key with that id." });
  const patch: { name?: string; scopes?: any[]; rateLimit?: number } = {};
  if (req.body?.name !== undefined) {
    const name = cleanName(req.body.name);
    if (!name) return res.status(400).json({ ok: false, error: "invalid_name", message: "Give the key a name (80 characters at most)." });
    patch.name = name;
  }
  if (req.body?.scopes !== undefined) {
    const scopes = normalizeScopes(req.body.scopes);
    if (!scopes.ok) return res.status(400).json({ ok: false, error: "invalid_scopes", message: scopes.error });
    patch.scopes = scopes.scopes;
  }
  if (req.body?.rate_limit_per_minute !== undefined) {
    const limit = parseRateLimit(req.body.rate_limit_per_minute);
    if (!limit.ok) return res.status(400).json({ ok: false, error: "invalid_rate_limit", message: limit.error });
    patch.rateLimit = limit.value;
  }
  const key = await updateApiKey(db(), id, silo, patch);
  if (!key) return res.status(404).json({ ok: false, error: "not_found", message: "No active key with that id." });
  await auditFor(req, "api_key_updated", { silo, changes: Object.keys(patch), scopes: key.scopes, rate_limit_per_minute: key.rate_limit_per_minute, key_prefix: key.key_prefix }, { type: "api_key", id: key.id });
  res.json({ ok: true, data: { key } });
}));

router.delete("/:id", safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return res.status(404).json({ ok: false, error: "not_found", message: "No active key with that id." });
  const key = await revokeApiKey(db(), id, silo, actorId(req));
  if (!key) return res.status(404).json({ ok: false, error: "not_found", message: "No active key with that id." });
  await auditFor(req, "api_key_revoked", { name: key.name, silo, scopes: key.scopes, key_prefix: key.key_prefix }, { type: "api_key", id: key.id });
  res.json({ ok: true, data: { key } });
}));

export default router;
