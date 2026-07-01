// BF_SERVER_GA4_MP_v1 - server-side GA4 conversion via Measurement Protocol.
// Browser-independent: no GTM, no consent banner, no ad blocker can stop it.
// No-op until GA4_MP_API_SECRET is set, so it is safe to ship before the secret.
import { randomUUID } from "node:crypto";

const MEASUREMENT_ID = process.env.GA4_MP_MEASUREMENT_ID || "G-D1Y4105RXP";

export async function sendGa4Event(
  name: string,
  params: Record<string, unknown> = {},
  clientId?: string,
): Promise<void> {
  const secret = process.env.GA4_MP_API_SECRET;
  if (!secret) return; // not configured yet -> silently skip
  try {
    const url =
      "https://www.google-analytics.com/mp/collect" +
      `?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}` +
      `&api_secret=${encodeURIComponent(secret)}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId || randomUUID(),
        events: [{ name, params }],
      }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error({ event: "ga4_mp_send_fail", err: String(err) });
  }
}
