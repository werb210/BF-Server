// BF_SERVER_v875_SSO - Admin settings for "Sign in with Microsoft". Mounted at /api/sso-settings. One switch for the
// whole of Boreal (every silo signs in the same way); the custom-role matrix maps it to Settings.
//   GET /api/sso-settings   the saved switch, whether the server has the Entra app's secret, the Entra app and tenant,
//                           and the redirect address to register on the Entra app
//   PUT /api/sso-settings   { microsoft_enabled }
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { BOREAL_ENTRA_CLIENT_ID, BOREAL_ENTRA_TENANT_ID, providerConfig, serverBaseUrl, ssoReturnUrl } from "../sso/oidc.js";
import { loadSsoAvailability, parseSsoPatch, readSsoSettings, saveSsoSettings } from "../sso/settings.js";

const router = Router();
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN] }));
const db = () => pool as unknown as Q;

async function view() {
  const a = await loadSsoAvailability(db());
  const cfg = providerConfig("microsoft");
  return {
    ok: true,
    settings: a.settings,
    microsoft: {
      ...a.microsoft,
      client_id: cfg?.clientId ?? (String(process.env.MSAL_CLIENT_ID ?? "").trim() || BOREAL_ENTRA_CLIENT_ID),
      tenant_id: cfg?.tenantId ?? BOREAL_ENTRA_TENANT_ID,
      redirect_uri: cfg?.redirectUri ?? `${serverBaseUrl()}/api/auth/sso/microsoft/callback`,
      return_url: ssoReturnUrl(),
    },
  };
}

router.get("/", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await view());
}));

router.put("/", safeHandler(async (req: any, res: any) => {
  const parsed = parseSsoPatch(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_settings", message: parsed.error });
  const current = await readSsoSettings(db());
  const next = { ...current, ...parsed.value };
  if (next.microsoft_enabled && !current.microsoft_enabled && !providerConfig("microsoft")) {
    return res.status(400).json({
      ok: false, error: "not_configured",
      message: "The server does not have the Microsoft app's client secret yet (MSAL_CLIENT_SECRET). Add it, then turn this on.",
    });
  }
  const saved = await saveSsoSettings(db(), next, actorId(req));
  await auditFor(req, "sso_settings_updated", { before: current, after: saved }, { type: "sso_settings", id: "sso" });
  res.json(await view());
}));

export default router;
