// BF_SERVER_SHARED_MAILBOX_DIAGNOSTIC_v291
// Microsoft answers "Default folder Inbox not found" (404) for a shared mailbox
// both when the signed-in account has no Full Access to it and when the access
// token was issued without the shared-mailbox permission (Mail.Read.Shared).
// Exchange shows Full Access is granted, so log what the token actually is:
// which account it belongs to and which permissions it carries. The token's
// claims are read locally; the token itself is never logged.
export type TokenIdentity = { account: string | null; scopes: string[]; hasSharedMailboxScope: boolean };

export function tokenIdentity(accessToken: string | null | undefined): TokenIdentity {
  try {
    const part = String(accessToken ?? "").split(".")[1];
    if (!part) return { account: null, scopes: [], hasSharedMailboxScope: false };
    const claims = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const scopes = String(claims.scp ?? "").split(" ").filter(Boolean);
    return {
      account: claims.upn ?? claims.unique_name ?? claims.preferred_username ?? null,
      scopes,
      hasSharedMailboxScope: scopes.some((s) => /^Mail\.(Read|ReadWrite)\.Shared$/i.test(s)),
    };
  } catch {
    return { account: null, scopes: [], hasSharedMailboxScope: false };
  }
}

const lastLogged = new Map<string, number>();
const LOG_EVERY_MS = 10 * 60 * 1000;

/** True at most once every 10 minutes per user + mailbox, so the portal's 20s polling cannot flood the log. */
export function shouldLogSharedFailure(userId: string, mailbox: string, now = Date.now()): boolean {
  const key = `${userId}:${mailbox.toLowerCase()}`;
  const last = lastLogged.get(key) ?? 0;
  if (now - last < LOG_EVERY_MS) return false;
  lastLogged.set(key, now);
  return true;
}

export function sharedMailboxReason(mailbox: string, identity: TokenIdentity): string {
  if (!identity.hasSharedMailboxScope) {
    return `Office 365 is connected without permission to read shared mailboxes. Reconnect Office 365 and accept all permissions to see ${mailbox}.`;
  }
  return `${identity.account ?? "The connected Microsoft account"} cannot open ${mailbox}. Check that this exact account has Read and manage (Full Access) on ${mailbox}, then wait up to an hour.`;
}
