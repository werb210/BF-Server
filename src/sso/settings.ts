// BF_SERVER_v875_SSO - the Admin switch for "Sign in with Microsoft" (boreal_settings key 'sso') and what is offered.
//
// Microsoft sign-in is offered on the sign-in page only when both hold: the server has the Entra app's client secret
// (MSAL_CLIENT_SECRET) and an Admin has switched it on in Settings > Microsoft sign-in. It is an extra way in: the
// text-code and passkey sign-ins keep working for everyone, and a Microsoft sign-in counts as a strong sign-in for
// the "require a passkey or two-step sign-in" switch (src/security/sessions.ts), like a passkey.
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";
import { providerConfig } from "./oidc.js";

export type SsoSettings = { microsoft_enabled: boolean };

export const DEFAULT_SSO_SETTINGS: SsoSettings = { microsoft_enabled: false };

export function normalizeSsoSettings(raw: unknown): SsoSettings {
  return { microsoft_enabled: (raw as any)?.microsoft_enabled === true };
}

export async function readSsoSettings(db: Q): Promise<SsoSettings> {
  return readSetting(db, "sso", normalizeSsoSettings);
}

export async function saveSsoSettings(db: Q, next: SsoSettings, by: string | null): Promise<SsoSettings> {
  const value = normalizeSsoSettings(next);
  await writeSetting(db, "sso", value, by);
  return value;
}

/** Validates a PUT body. Unknown keys are ignored; wrong types are refused. */
export function parseSsoPatch(raw: unknown): { ok: true; value: Partial<SsoSettings> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send the settings as a JSON object." };
  const b = raw as Record<string, unknown>;
  const out: Partial<SsoSettings> = {};
  if (b.microsoft_enabled !== undefined) {
    if (typeof b.microsoft_enabled !== "boolean") return { ok: false, error: "microsoft_enabled must be true or false." };
    out.microsoft_enabled = b.microsoft_enabled;
  }
  return { ok: true, value: out };
}

export type SsoAvailability = {
  microsoft: { configured: boolean; enabled: boolean; available: boolean };
  settings: SsoSettings;
};

/** Pure: what is offered given the env and the stored settings. */
export function ssoAvailability(settings: SsoSettings, e: NodeJS.ProcessEnv = process.env): SsoAvailability {
  const configured = providerConfig("microsoft", e) !== null;
  return { microsoft: { configured, enabled: settings.microsoft_enabled, available: configured && settings.microsoft_enabled }, settings };
}

/** Reads the settings. A read failure is logged and treated as "off" (the other sign-ins still work). */
export async function loadSsoAvailability(db: Q, e: NodeJS.ProcessEnv = process.env): Promise<SsoAvailability> {
  try {
    return ssoAvailability(await readSsoSettings(db), e);
  } catch (err) {
    logWarnSwallowed(err, "sso/settings.ts:loadSsoAvailability");
    return ssoAvailability({ ...DEFAULT_SSO_SETTINGS }, e);
  }
}
