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
    const message = `Incomplete Watch APNs configuration; missing: ${missing.join(", ")}`;
    if (env.NODE_ENV === "production") throw new Error(message);
    console.warn(JSON.stringify({ event: "watch_apns_not_configured", missing }));
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
