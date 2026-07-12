// BF_SERVER_TEAMS_AUTO_RECORD_v1
// A Teams meeting only produces a transcript if somebody presses Record. There is
// NO tenant-wide admin policy that forces this - Microsoft's own docs say the
// "Record and transcribe automatically" option has no admin policy, and the only
// way to force it is a Teams Premium meeting template. So instead of relying on
// staff remembering, we set it on the meeting itself: the Graph onlineMeeting
// resource exposes `recordAutomatically`, and we already create the meeting.
//
// Requires OnlineMeetings.ReadWrite.All (Application) on "Boreal Financial Server".
import type { Pool } from "pg";
import { graphAppFetch, isAppGraphConfigured } from "./graphAppClient.js";

const RESOLVE_ATTEMPTS = 4;
const RESOLVE_DELAY_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveAadId(upn: string): Promise<string | null> {
  const resp = await graphAppFetch(`/users/${encodeURIComponent(upn)}?$select=id`);
  if (!resp.ok) return null;
  const json = (await resp.json()) as { id?: string };
  return json.id ?? null;
}

async function resolveMeetingId(userId: string, joinUrl: string): Promise<string | null> {
  // Teams provisions the onlineMeeting a beat after the calendar event is created,
  // so the first lookup can legitimately come back empty. Retry briefly.
  const literal = joinUrl.replace(/'/g, "''");
  const path =
    `/users/${encodeURIComponent(userId)}/onlineMeetings` +
    `?$filter=joinWebUrl eq '${encodeURIComponent(literal)}'`;
  for (let i = 0; i < RESOLVE_ATTEMPTS; i++) {
    const resp = await graphAppFetch(path);
    if (resp.ok) {
      const json = (await resp.json()) as { value?: Array<{ id?: string }> };
      const id = json.value?.[0]?.id;
      if (id) return id;
    }
    if (i < RESOLVE_ATTEMPTS - 1) await sleep(RESOLVE_DELAY_MS);
  }
  return null;
}

// Best-effort and fire-and-forget: a failure here must NEVER break scheduling. It is
// logged loudly instead (never a bare catch - that hid a total failure for a whole
// session once already).
export async function enableAutoRecording(
  pool: Pool,
  graphEventId: string,
  organizerUpn: string,
  joinUrl: string,
): Promise<void> {
  if (!isAppGraphConfigured()) {
    console.error("teams_auto_record_skipped", { reason: "app_graph_not_configured" });
    return;
  }
  try {
    const upn = organizerUpn.toLowerCase();
    const aadId = await resolveAadId(upn);
    if (!aadId) {
      console.error("teams_auto_record_no_aad_id", { upn });
      return;
    }
    const meetingId = await resolveMeetingId(aadId, joinUrl);
    if (!meetingId) {
      console.error("teams_auto_record_no_meeting_id", { graph_event_id: graphEventId });
      return;
    }

    const resp = await graphAppFetch(
      `/users/${encodeURIComponent(aadId)}/onlineMeetings/${encodeURIComponent(meetingId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordAutomatically: true }),
      },
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      console.error("teams_auto_record_patch_failed", {
        status: resp.status,
        detail: detail.slice(0, 600),
      });
      return;
    }

    // Cache what we resolved so the transcript poller does not have to redo it.
    await pool.query(
      `UPDATE teams_meetings
          SET organizer_aad_id = COALESCE(organizer_aad_id, $2),
              graph_meeting_id = COALESCE(graph_meeting_id, $3),
              updated_at = now()
        WHERE graph_event_id = $1`,
      [graphEventId, aadId, meetingId],
    );
    console.log("teams_auto_record_enabled", { graph_event_id: graphEventId });
  } catch (e: any) {
    console.error("teams_auto_record_threw", { message: e?.message });
  }
}
