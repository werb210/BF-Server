// BF_SERVER_v852_CALC_QBO - QuickBooks Online (Intuit) settings, read from the environment on every call.
//
//   QBO_CLIENT_ID             the Intuit app's client id                      (required)
//   QBO_CLIENT_SECRET         the Intuit app's client secret                  (required)
//   QBO_TOKEN_ENCRYPTION_KEY  encrypts the stored tokens, 32+ characters      (required)
//   QBO_REDIRECT_URI          default {PUBLIC_BASE_URL}/api/quickbooks/oauth/callback
//   QBO_ENVIRONMENT           sandbox | production, default sandbox
//   QBO_RETURN_URL            where the browser lands after connecting, default {PORTAL_URL}/settings/quickbooks
//
// With any required value missing the whole feature is off: no routes call Intuit, nothing is queued, the worker
// does nothing, and the portal shows the QuickBooks card greyed out with the reason.

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com";
export const QBO_PRODUCTION_API = "https://quickbooks.api.intuit.com";
export const QBO_MINOR_VERSION = "75";
export const QBO_MIN_KEY_LENGTH = 32;

export type QboEnvironment = "sandbox" | "production";

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined): string => (typeof v === "string" ? v.trim() : "");

/** The required settings that are not set (names only, never values). */
export function qboMissingSettings(env: Env = process.env): string[] {
  const missing: string[] = [];
  if (!clean(env.QBO_CLIENT_ID)) missing.push("QBO_CLIENT_ID");
  if (!clean(env.QBO_CLIENT_SECRET)) missing.push("QBO_CLIENT_SECRET");
  if (clean(env.QBO_TOKEN_ENCRYPTION_KEY).length < QBO_MIN_KEY_LENGTH) missing.push("QBO_TOKEN_ENCRYPTION_KEY");
  return missing;
}

export function qboConfigured(env: Env = process.env): boolean {
  return qboMissingSettings(env).length === 0;
}

export function qboEnvironment(env: Env = process.env): QboEnvironment {
  return clean(env.QBO_ENVIRONMENT).toLowerCase() === "production" ? "production" : "sandbox";
}

/** The Accounting API host: the Intuit sandbox unless QBO_ENVIRONMENT=production. */
export function qboApiBase(env: Env = process.env): string {
  return qboEnvironment(env) === "production" ? QBO_PRODUCTION_API : QBO_SANDBOX_API;
}

export function qboRedirectUri(env: Env = process.env): string {
  const explicit = clean(env.QBO_REDIRECT_URI);
  if (explicit) return explicit;
  const server = (clean(env.PUBLIC_BASE_URL) || "https://server.boreal.financial").replace(/\/+$/, "");
  return server + "/api/quickbooks/oauth/callback";
}

export function qboReturnUrl(result: "connected" | "error", env: Env = process.env): string {
  const portal = (clean(env.PORTAL_URL) || "https://staff.boreal.financial").replace(/\/+$/, "");
  const base = clean(env.QBO_RETURN_URL) || portal + "/settings/quickbooks";
  return base + (base.includes("?") ? "&" : "?") + "quickbooks=" + result;
}

/** Where staff open an invoice in QuickBooks. */
export function qboInvoiceUrl(invoiceId: string, env: Env = process.env): string {
  const host = qboEnvironment(env) === "production" ? "https://app.qbo.intuit.com" : "https://app.sandbox.qbo.intuit.com";
  return host + "/app/invoice?txnId=" + encodeURIComponent(invoiceId);
}

export function qboCredentials(env: Env = process.env): { clientId: string; clientSecret: string } {
  return { clientId: clean(env.QBO_CLIENT_ID), clientSecret: clean(env.QBO_CLIENT_SECRET) };
}
