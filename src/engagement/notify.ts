// BF_SERVER_ENGAGEMENT_v1 - replies and bookings found on this side, filed in both places: Keystone (and other BF-Server
// silos) here, PGI on BI-Server (matched there by email to contacts its flows reached). Never throws.
import type { Pool } from "pg";
import { signServiceToken } from "../auth/serviceTokens.js";
import { biServerBaseUrl } from "../services/biOutreach.js";
import { reachedContactsByEmail, recordEvent, recordReply } from "./engagement.js";

async function postBi(path: string, body: Record<string, unknown>): Promise<any> {
  try {
    const r = await fetch(`${biServerBaseUrl()}/api/v1/bi/internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${signServiceToken("bi-server")}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) { console.warn("[engagement] BI call failed", { path, status: r.status }); return null; }
    return await r.json();
  } catch (err) {
    console.warn("[engagement] BI call failed", { path, message: (err as Error)?.message });
    return null;
  }
}
export async function getBi(path: string): Promise<any> {
  try {
    const r = await fetch(`${biServerBaseUrl()}/api/v1/bi/internal${path}`, {
      headers: { authorization: `Bearer ${signServiceToken("bi-server")}` }, signal: AbortSignal.timeout(10_000),
    });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export type InboundReply = { email: string; at: Date; subject?: string | null; body?: string | null; mailbox?: string | null };
/** A reply in any mailbox: label it, open the follow-up, stop that person's flow emails. */
export async function noteReply(db: Pick<Pool, "query">, rep: InboundReply): Promise<{ local: number; bi: number }> {
  let local = 0;
  for (const c of await reachedContactsByEmail(db, rep.email)) {
    const k = await recordReply(db, { contactId: c.id, at: rep.at, subject: rep.subject, body: rep.body, mailbox: rep.mailbox }).catch(() => null);
    if (k) local += 1;
  }
  if (local) {
    await db.query(
      `UPDATE crm_flow_members SET status = 'stopped', stop_reason = 'replied', next_key = NULL, next_at = NULL, updated_at = now()
        WHERE lower(email) = $1 AND status IN ('active', 'queued') AND first_sent_at IS NOT NULL AND first_sent_at < $2`,
      [rep.email.toLowerCase(), rep.at],
    ).catch((err: unknown) => console.warn("[engagement] flow stop failed", { message: (err as Error)?.message }));
  }
  const bi = await postBi("/engagement/reply", { email: rep.email, at: rep.at.toISOString(), subject: rep.subject ?? null, body: rep.body ?? null, mailbox: rep.mailbox ?? null });
  return { local, bi: Number(bi?.matched ?? 0) };
}

/** A booking (Microsoft Bookings or a meeting) with someone from the outreach. */
export async function noteBooking(db: Pick<Pool, "query">, email: string, start: string | null, source: string): Promise<void> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return;
  for (const c of await reachedContactsByEmail(db, e)) {
    await recordEvent(db, { contactId: c.id, kind: "booked", detail: { start, source }, actor: "Booking" }).catch(() => false);
  }
  await postBi("/engagement/event", { email: e, kind: "booked", start, source });
}
