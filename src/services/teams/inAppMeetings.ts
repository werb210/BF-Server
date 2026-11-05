// BF_SERVER_v888_TEAMS_IN_APP
// Join a Boreal Teams meeting from inside the staff portal or the client app, without
// installing Teams. Azure Communication Services (ACS) joins Teams meetings through
// "Teams interop": the app gets a short-lived ACS user token from here and joins the
// meeting's Teams link with the ACS Calling SDK. Clients land in the Teams lobby and
// the organiser admits them, exactly as if they had joined from a browser.
//
// This file only decides WHO may join WHICH meeting and issues the token. Meetings are
// still created by the existing code (CRM Meeting popup -> routes/crm/meetings.ts, and
// client bookings -> services/clientBooking.ts), both of which register the meeting in
// teams_meetings. Transcripts, recordings and the Maya summary stay with the existing
// poller (workers/teamsTranscriptWorker.ts + services/teams/meetingIntel.ts).
import { pool } from "../../db.js";
import { getGraphForUser } from "../../modules/o365/graphClient.js";

export const ACS_TOKEN_SCOPES = ["voip"] as const;

export type JoinableMeeting = {
  id: string;
  subject: string | null;
  join_url: string;
  scheduled_at: string | null;
  scheduled_end_at: string | null;
  organizer_user_id: string | null;
  staff_first_name: string | null;
  client_name: string | null;
  contact_name: string | null;
};

export type AcsToken = { token: string; expiresOn: string; acsUserId: string };

export function isAcsConfigured(): boolean {
  return Boolean(String(process.env.ACS_CONNECTION_STRING ?? "").trim());
}

/** Only real Teams meeting links can be joined; never an arbitrary URL. */
export function isTeamsJoinUrl(url: unknown): url is string {
  return typeof url === "string" && /^https:\/\/teams\.(microsoft|live)\.com\/(l\/meetup-join|meet)\//i.test(url.trim());
}

/** Last 10 digits of a phone number, or "" when there are fewer than 10. */
export function phone10(raw: unknown): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/** Clients may get a token from an hour before the start until three hours after the end. */
export const CLIENT_EARLY_MS = 60 * 60_000;
export const CLIENT_LATE_MS = 3 * 60 * 60_000;
export function clientCanJoinNow(m: Pick<JoinableMeeting, "scheduled_at" | "scheduled_end_at">, now = Date.now()): boolean {
  const start = m.scheduled_at ? new Date(m.scheduled_at).getTime() : NaN;
  if (Number.isNaN(start)) return false;
  const endRaw = m.scheduled_end_at ? new Date(m.scheduled_end_at).getTime() : NaN;
  const end = Number.isNaN(endRaw) ? start + 60 * 60_000 : endRaw;
  return now >= start - CLIENT_EARLY_MS && now <= end + CLIENT_LATE_MS;
}

// One shape for every lookup. A meeting is a teams_meetings row, joined to the CRM meeting,
// the client booking (when it came from "Book a call") and the contact it is tagged to.
// Cancelled CRM meetings and failed or cancelled bookings are never joinable.
const SELECT_JOINABLE = `
  SELECT tm.id::text, tm.subject, tm.join_url, tm.scheduled_at, tm.scheduled_end_at,
         tm.organizer_user_id::text,
         u.first_name AS staff_first_name,
         b.client_name, c.name AS contact_name
    FROM teams_meetings tm
    LEFT JOIN crm_meetings m ON m.id = tm.crm_meeting_id
    LEFT JOIN client_bookings b ON b.crm_meeting_id = tm.crm_meeting_id AND tm.crm_meeting_id IS NOT NULL
    LEFT JOIN contacts c ON c.id = tm.contact_id
    LEFT JOIN users u ON u.id = tm.organizer_user_id
   WHERE tm.join_url IS NOT NULL
     AND COALESCE(m.status, 'scheduled') <> 'cancelled'
     AND COALESCE(b.status, 'booked') NOT IN ('failed', 'cancelled')`;

// The client is identified by the mobile number they signed in with. They are invited when
// the meeting is tagged to a contact with that number, or the booking was made with it.
const CLIENT_MATCH = `(
       right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
    OR right(regexp_replace(COALESCE(b.client_phone, ''), '[^0-9]', '', 'g'), 10) = $1)`;

// Staff are invited when they organise it, own the CRM meeting, took the booking, or are
// on the CRM meeting's attendee list.
const STAFF_MATCH = `(
       tm.organizer_user_id = $1::uuid
    OR m.owner_id = $1::uuid
    OR b.staff_user_id = $1::uuid
    OR ($2::text <> '' AND lower(COALESCE(tm.organizer_upn, '')) = lower($2))
    OR ($2::text <> '' AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(m.attendees_json, '[]'::jsonb)) a
          WHERE lower(COALESCE(a->>'address', a->>'email', '')) = lower($2))))`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A meeting id from the apps may be the teams_meetings id, the booking id or the CRM meeting id. */
const idMatch = (p: string) => `(tm.id = ${p}::uuid OR tm.crm_meeting_id = ${p}::uuid OR b.id = ${p}::uuid)`;

export async function findMeetingForClient(clientPhone10: string, meetingId: string): Promise<JoinableMeeting | null> {
  if (!clientPhone10 || !UUID_RE.test(meetingId)) return null;
  const { rows } = await pool.query<JoinableMeeting>(
    `${SELECT_JOINABLE} AND ${CLIENT_MATCH} AND ${idMatch("$2")}
     ORDER BY tm.scheduled_at DESC NULLS LAST LIMIT 1`,
    [clientPhone10, meetingId],
  );
  return rows[0] ?? null;
}

export async function listMeetingsForClient(clientPhone10: string): Promise<JoinableMeeting[]> {
  if (!clientPhone10) return [];
  const { rows } = await pool.query<JoinableMeeting>(
    `${SELECT_JOINABLE} AND ${CLIENT_MATCH}
       AND COALESCE(tm.scheduled_end_at, tm.scheduled_at + interval '1 hour') > now() - interval '3 hours'
       AND tm.scheduled_at < now() + interval '60 days'
     ORDER BY tm.scheduled_at ASC LIMIT 20`,
    [clientPhone10],
  );
  return rows;
}

export async function findMeetingForStaff(
  staff: { userId: string; email: string },
  ref: { meetingId?: string | null; joinUrl?: string | null },
): Promise<JoinableMeeting | null> {
  if (!UUID_RE.test(staff.userId)) return null;
  const byId = ref.meetingId && UUID_RE.test(ref.meetingId) ? ref.meetingId : null;
  const byUrl = !byId && isTeamsJoinUrl(ref.joinUrl) ? ref.joinUrl.trim() : null;
  if (!byId && !byUrl) return null;
  const { rows } = await pool.query<JoinableMeeting>(
    byId
      ? `${SELECT_JOINABLE} AND ${STAFF_MATCH} AND ${idMatch("$3")} ORDER BY tm.scheduled_at DESC NULLS LAST LIMIT 1`
      : `${SELECT_JOINABLE} AND ${STAFF_MATCH} AND tm.join_url = $3 ORDER BY tm.scheduled_at DESC NULLS LAST LIMIT 1`,
    [staff.userId, staff.email, byId ?? byUrl],
  );
  return rows[0] ?? null;
}

/**
 * A meeting on the staff member's own Outlook calendar (the portal Calendar page) may
 * not be in teams_meetings at all, for example one someone outside Boreal sent them.
 * Being on their calendar is the invitation: read the event with their own Microsoft
 * sign-in and check that its Teams link is the one they asked to join.
 */
export async function staffCalendarHasMeeting(userId: string, calendarEventId: string, joinUrl: string): Promise<{ subject: string | null; startsAt: string | null } | null> {
  if (!calendarEventId || !isTeamsJoinUrl(joinUrl)) return null;
  const graph = await getGraphForUser(pool, userId);
  if (!graph) return null;
  try {
    const resp = await graph.fetch(`/me/events/${encodeURIComponent(calendarEventId)}?$select=subject,start,onlineMeeting`);
    if (!resp.ok) {
      console.warn("[teams-in-app] calendar event lookup failed", { status: resp.status });
      return null;
    }
    const ev = (await resp.json()) as { subject?: string; start?: { dateTime?: string }; onlineMeeting?: { joinUrl?: string } };
    if (String(ev.onlineMeeting?.joinUrl ?? "").trim() !== joinUrl.trim()) return null;
    return { subject: ev.subject ?? null, startsAt: ev.start?.dateTime ?? null };
  } catch (err) {
    console.warn("[teams-in-app] calendar event lookup threw", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** The staff member's name for the meeting roster and the mailbox Teams invites go to. */
export async function staffIdentity(userId: string): Promise<{ displayName: string; email: string }> {
  if (!UUID_RE.test(userId)) return { displayName: "Boreal Financial", email: "" };
  const { rows } = await pool.query<{ first_name: string | null; last_name: string | null; email: string | null; o365_user_email: string | null }>(
    `SELECT first_name, last_name, email, o365_user_email FROM users WHERE id = $1::uuid LIMIT 1`, [userId]);
  const r = rows[0];
  const name = [r?.first_name, r?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return {
    displayName: name ? name + " (Boreal Financial)" : "Boreal Financial",
    email: String(r?.o365_user_email || r?.email || "").trim(),
  };
}

/** A fresh ACS user with a VoIP token (valid 24 hours). One user per join. */
export async function issueAcsToken(): Promise<AcsToken> {
  const conn = String(process.env.ACS_CONNECTION_STRING ?? "").trim();
  if (!conn) throw new Error("acs_not_configured");
  const { CommunicationIdentityClient } = await import("@azure/communication-identity");
  const client = new CommunicationIdentityClient(conn);
  const out = await client.createUserAndToken([...ACS_TOKEN_SCOPES]);
  return { token: out.token, expiresOn: out.expiresOn.toISOString(), acsUserId: out.user.communicationUserId };
}

// BF_SERVER_v890_TEAMS_IDENTITY - staff join as themselves (their own Teams identity: their name, no lobby, the
// organiser's controls) instead of as an anonymous guest. The portal signs the person in to Microsoft for Azure
// Communication Services (scopes Teams.ManageCalls and Teams.ManageChats on the Boreal Entra app) and sends that
// token here; ACS checks it and exchanges it for an ACS token for that Teams user. Clients always join as guests.
export type TeamsTokenClaims = { oid: string; appId: string; email: string };

/** Reads the claims we need from a Microsoft access token (ACS itself checks the signature). Null if malformed. */
export function teamsTokenClaims(aadToken: unknown): TeamsTokenClaims | null {
  if (typeof aadToken !== "string" || aadToken.length > 8000) return null;
  const parts = aadToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const oid = String(c.oid ?? "");
    const appId = String(c.appid ?? c.azp ?? "");
    const email = String(c.upn ?? c.preferred_username ?? c.unique_name ?? "").toLowerCase();
    if (!/^[0-9a-f-]{36}$/i.test(oid) || !appId) return null;
    return { oid, appId, email };
  } catch { return null; }
}

/** The Entra app the portal signs in with (the token must be for it). */
export function teamsClientId(): string {
  return String(process.env.ACS_TEAMS_CLIENT_ID ?? process.env.MSAL_CLIENT_ID ?? "").trim();
}

/**
 * Exchanges the staff member's Microsoft token for an ACS token for their Teams identity. The token must be for
 * Boreal's Entra app and for the same mailbox as their Boreal account.
 */
export async function issueTeamsUserToken(aadToken: string, staffEmail: string): Promise<AcsToken & { identity: "teams" }> {
  const conn = String(process.env.ACS_CONNECTION_STRING ?? "").trim();
  if (!conn) throw new Error("acs_not_configured");
  const claims = teamsTokenClaims(aadToken);
  if (!claims) throw new Error("teams_token_invalid");
  const clientId = teamsClientId();
  if (!clientId || claims.appId !== clientId) throw new Error("teams_token_wrong_app");
  if (staffEmail && claims.email && claims.email !== staffEmail.toLowerCase()) throw new Error("teams_token_wrong_person");
  const { CommunicationIdentityClient } = await import("@azure/communication-identity");
  const client = new CommunicationIdentityClient(conn);
  const out = await client.getTokenForTeamsUser({ teamsUserAadToken: aadToken, clientId, userObjectId: claims.oid });
  return { token: out.token, expiresOn: out.expiresOn.toISOString(), acsUserId: "teams:" + claims.oid, identity: "teams" };
}

/**
 * A Teams booking made through "Book a call" becomes a teams_meetings row, so the
 * existing transcript poller pulls its recording link, transcript and Maya summary
 * onto the contact's timeline, and the client can join it in the app.
 */
export async function registerBookingTeamsMeeting(input: {
  contactId: string | null;
  crmMeetingId: string;
  staffUserId: string;
  staffMailbox: string;
  subject: string;
  graphEventId: string;
  joinUrl: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO teams_meetings
         (silo, contact_id, crm_meeting_id, organizer_user_id, organizer_upn,
          subject, graph_event_id, join_url, scheduled_at, scheduled_end_at, status)
       VALUES ('BF', $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, 'scheduled')
       ON CONFLICT (graph_event_id) DO UPDATE
         SET join_url = EXCLUDED.join_url,
             scheduled_at = EXCLUDED.scheduled_at,
             scheduled_end_at = EXCLUDED.scheduled_end_at,
             updated_at = now()`,
      [input.contactId, input.crmMeetingId, input.staffUserId, input.staffMailbox, input.subject,
        input.graphEventId, input.joinUrl, input.startsAt.toISOString(), input.endsAt.toISOString()],
    );
  } catch (err) {
    // Booking must still succeed; the failure has to be visible in the logs.
    console.error("[booking] teams_meeting_register_failed", {
      graph_event_id: input.graphEventId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
