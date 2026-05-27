// BF_SERVER_BLOCK_v105_KEEP_WARM_v1
// Pings the app's own /health endpoint every 5 minutes as a backstop
// against idle-sleep. The Azure App Service WEBSITE_HOSTNAME env var
// gives us the public hostname.
export function startKeepWarm(): void {
  const host = process.env.WEBSITE_HOSTNAME;
  if (!host) return; // not running on App Service, skip
  const interval = 5 * 60 * 1000;
  setInterval(() => {
    fetch(`https://${host}/health`).catch((err) => {
      // Don't crash on transient self-ping failures.
      console.warn("[keepWarm] self-ping failed:", (err as Error).message);
    });
  }, interval).unref();
}
