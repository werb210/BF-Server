import { AppleWatchApnsProvider } from "./apnsProvider.js";
import { configureWatchPushProvider } from "./notifications.js";

const NAMES = ["WATCH_APNS_TEAM_ID", "WATCH_APNS_KEY_ID", "WATCH_APNS_PRIVATE_KEY", "WATCH_APNS_BUNDLE_ID"] as const;

export function initializeWatchPushProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  // Unit/integration processes must never construct a production network transport.
  if (env.NODE_ENV === "test") return false;
  const present = NAMES.filter((name) => Boolean(env[name]?.trim()));
  if (present.length === 0) {
    console.warn(JSON.stringify({ event: "watch_apns_not_configured" }));
    return false;
  }
  const missing = NAMES.filter((name) => !env[name]?.trim());
  if (missing.length) {
    // BF_SERVER_BLOCK_v335_PUSH_INIT_NON_FATAL_v1
    // This threw in production and took the whole server down on the staging
    // slot 2026-09-08: WATCH_APNS_BUNDLE_ID was set, the other three were not,
    // and the throw landed on line 3 of start() -- before app.listen(). The
    // global error handler swallowed it, so every background worker ran while
    // no port was ever bound. Azure reported Degraded and recycled the
    // container while the workers kept hitting the database.
    // Push is an optional subsystem. Partial config disables push loudly; it
    // does not prevent the API from serving.
    console.error(JSON.stringify({
      event: "watch_apns_misconfigured",
      missing,
      effect: "push disabled; server continues",
    }));
    return false;
  }
  const privateKey = env.WATCH_APNS_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const bundleId = env.WATCH_APNS_BUNDLE_ID!.trim();
  const provider = new AppleWatchApnsProvider({
    teamId: env.WATCH_APNS_TEAM_ID!.trim(), keyId: env.WATCH_APNS_KEY_ID!.trim(), privateKey, bundleId,
  });
  configureWatchPushProvider(provider);
  console.log(JSON.stringify({ event: "watch_apns_initialized", bundleId, configured: true }));
  return true;
}
