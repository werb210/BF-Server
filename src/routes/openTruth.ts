// BF_SERVER_OPEN_TRUTH_v52 - shared, side-effect-free open tracking helpers.
export function isOwnTrackingPixel(rawUrl: string): boolean {
  try {
    return /\/api\/track\/email\/[^/]+\.gif$/i.test(new URL(rawUrl).pathname);
  } catch {
    return false;
  }
}

export function classifyOpenSource(userAgent: string | null | undefined): string {
  const ua = String(userAgent ?? "").toLowerCase();
  if (!ua) return "unknown";
  if (ua.includes("googleimageproxy")) return "proxy_gmail";
  if (ua.includes("applemail") || ua.includes("apple-mail")) return "proxy_apple";
  if (/proofpoint|mimecast|barracuda|forcepoint|symantec|trendmicro|messagelabs|microsoft office|safelinks|bingpreview/.test(ua)) {
    return "scanner";
  }
  if (/\bbot\b|crawler|spider|curl|wget|python-requests|node-fetch|axios|headless/.test(ua)) return "bot";
  if (/mozilla|chrome|safari|firefox|edge|outlook/.test(ua)) return "human_likely";
  return "unknown";
}

export const MACHINE_SOURCES = ["proxy_gmail", "proxy_apple", "scanner", "bot"] as const;
