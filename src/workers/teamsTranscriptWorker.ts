// BF_SERVER_TEAMS_TRANSCRIPT_POLLER_v1
// After a Teams meeting ends, pull its transcript + recording link back onto the
// contact's CRM timeline. Poller rather than a Graph change-notification
// subscription: no public webhook to maintain, no subscription renewal, and
// Graph indexes transcripts a beat AFTER they appear in the Teams UI anyway, so
// a first immediate fetch would come back empty regardless. Retry is the design,
// not a workaround.
//
// Flow per row (teams_meetings, status='scheduled', past scheduled_end_at):
//   1. resolve the onlineMeeting id from join_url  -> graph_meeting_id
//   2. GET .../transcripts, then /content as text/vtt (speaker-attributed)
//   3. GET .../recordings -> store the LINK only (downloading the video needs
//      Sites.Selected, which we deliberately do not hold)
// Gives up after MAX_ATTEMPTS and parks the row as 'no_transcript' so a meeting
// nobody recorded is not retried forever.
import type { Pool } from "pg";
import { graphAppFetch, isAppGraphConfigured } from "../services/teams/graphAppClient.js";
// BF_SERVER_MAYA_MEETING_INTEL_v1
import { runMeetingIntel } from "../services/teams/meetingIntel.js";

const INTERVAL_MS = 10 * 60 * 1000;
const KICKOFF_MS = 25 * 1000;
const MAX_ATTEMPTS = 10;
const SETTLE_MINUTES = 5;
const BATCH = 10;

type PendingRow = {
  id: string;
  organizer_upn: string;
  organizer_aad_id: string | null;
  join_url: string | null;
  graph_meeting_id: string | null;
  transcript_attempts: number;
};

// BF_SERVER_TEAMS_ORGANIZER_AAD_ID_v1
// The onlineMeetings endpoints reject a UPN under application permissions
// ("The userId in request URL is not a GUID"), so every call below must be
// addressed with the organizer's Entra object id. Resolved once, then cached in
// teams_meetings.organizer_aad_id. This endpoint DOES accept a UPN.
async function resolveAadId(upn: string): Promise<string | null> {
  const resp = await graphAppFetch(`/users/${encodeURIComponent(upn)}?$select=id`);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("[teams-transcript] resolve_aad_id_failed", {
      upn,
      status: resp.status,
      detail: txt.slice(0, 300),
    });
    return null;
  }
  const json = (await resp.json()) as { id?: string };
  return json.id ?? null;
}

async function resolveMeetingId(userId: string, joinUrl: string): Promise<string | null> {
  // Graph matches onlineMeetings on the exact joinWebUrl. Single quotes inside an
  // OData string literal are escaped by doubling them.
  const literal = joinUrl.replace(/'/g, "''");
  const path =
    `/users/${encodeURIComponent(userId)}/onlineMeetings` +
    `?$filter=joinWebUrl eq '${encodeURIComponent(literal)}'`;
  const resp = await graphAppFetch(path);
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("[teams-transcript] resolve_meeting_failed", {
      status: resp.status,
      detail: txt.slice(0, 300),
    });
    return null;
  }
  const json = (await resp.json()) as { value?: Array<{ id?: string }> };
  return json.value?.[0]?.id ?? null;
}

async function fetchTranscript(userId: string, meetingId: string): Promise<string | null> {
  const listPath =
    `/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/transcripts`;
  const listResp = await graphAppFetch(listPath);
  if (!listResp.ok) {
    const txt = await listResp.text().catch(() => "");
    console.error("[teams-transcript] list_transcripts_failed", {
      status: listResp.status,
      detail: txt.slice(0, 300),
    });
    return null;
  }
  const list = (await listResp.json()) as {
    value?: Array<{ id?: string; createdDateTime?: string }>;
  };
  const items = list.value ?? [];
  if (!items.length) return null;

  // Newest transcript wins if a meeting somehow produced more than one.
  const newest = items
    .slice()
    .sort((a, b) =>
      String(b.createdDateTime ?? "").localeCompare(String(a.createdDateTime ?? "")),
    )[0];
  const transcriptId = newest?.id;
  if (!transcriptId) return null;

  const contentResp = await graphAppFetch(
    `${listPath}/${encodeURIComponent(transcriptId)}/content`,
    { headers: { Accept: "text/vtt" } },
  );
  if (!contentResp.ok) {
    const txt = await contentResp.text().catch(() => "");
    console.error("[teams-transcript] transcript_content_failed", {
      status: contentResp.status,
      detail: txt.slice(0, 300),
    });
    return null;
  }
  const vtt = await contentResp.text();
  return vtt.trim() ? vtt : null;
}

async function fetchRecordingUrl(userId: string, meetingId: string): Promise<string | null> {
  const path =
    `/users/${encodeURIComponent(userId)}/onlineMeetings/${encodeURIComponent(meetingId)}/recordings`;
  const resp = await graphAppFetch(path);
  if (!resp.ok) return null;
  const json = (await resp.json()) as {
    value?: Array<{ recordingContentUrl?: string; createdDateTime?: string }>;
  };
  const items = json.value ?? [];
  if (!items.length) return null;
  const newest = items
    .slice()
    .sort((a, b) =>
      String(b.createdDateTime ?? "").localeCompare(String(a.createdDateTime ?? "")),
    )[0];
  return newest?.recordingContentUrl ?? null;
}

async function processRow(pool: Pool, row: PendingRow): Promise<void> {
  // users.o365_user_email stores whatever casing the user typed; normalise it.
  const upn = row.organizer_upn.toLowerCase();

  // BF_SERVER_TEAMS_ORGANIZER_AAD_ID_v1 - onlineMeetings needs the Entra object
  // id, not the UPN. Resolve once and cache it on the row.
  let userId = row.organizer_aad_id;
  if (!userId) {
    userId = await resolveAadId(upn);
    if (!userId) {
      const bumped = row.transcript_attempts + 1;
      await pool.query(
        `UPDATE teams_meetings
            SET transcript_attempts = $2,
                status = CASE WHEN $3::boolean THEN 'no_transcript' ELSE status END,
                updated_at = now()
          WHERE id = $1`,
        [row.id, bumped, bumped >= MAX_ATTEMPTS],
      );
      return;
    }
    await pool.query(
      `UPDATE teams_meetings
          SET organizer_aad_id = $2, updated_at = now()
        WHERE id = $1`,
      [row.id, userId],
    );
  }

  let meetingId = row.graph_meeting_id;
  if (!meetingId) {
    if (!row.join_url) {
      await pool.query(
        `UPDATE teams_meetings
            SET status = 'no_transcript', updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      return;
    }
    meetingId = await resolveMeetingId(userId, row.join_url);
    if (meetingId) {
      await pool.query(
        `UPDATE teams_meetings
            SET graph_meeting_id = $2, updated_at = now()
          WHERE id = $1`,
        [row.id, meetingId],
      );
    }
  }

  let transcript: string | null = null;
  let recordingUrl: string | null = null;
  if (meetingId) {
    transcript = await fetchTranscript(userId, meetingId);
    recordingUrl = await fetchRecordingUrl(userId, meetingId);
  }

  if (transcript) {
    await pool.query(
      `UPDATE teams_meetings
          SET transcript_text = $2,
              transcript_fetched_at = now(),
              recording_url = COALESCE($3, recording_url),
              transcript_attempts = transcript_attempts + 1,
              status = 'transcribed',
              updated_at = now()
        WHERE id = $1`,
      [row.id, transcript, recordingUrl],
    );
    console.log("[teams-transcript] captured", { id: row.id, chars: transcript.length });
    return;
  }

  const nextAttempts = row.transcript_attempts + 1;
  const giveUp = nextAttempts >= MAX_ATTEMPTS;
  await pool.query(
    `UPDATE teams_meetings
        SET transcript_attempts = $2,
            recording_url = COALESCE($3, recording_url),
            status = CASE WHEN $4::boolean THEN 'no_transcript' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [row.id, nextAttempts, recordingUrl, giveUp],
  );
  if (giveUp) {
    console.log("[teams-transcript] gave up, no transcript", { id: row.id });
  }
}

export function startTeamsTranscriptWorker(pool: Pool): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    if (!isAppGraphConfigured()) return;
    running = true;
    try {
      const { rows } = await pool.query<PendingRow>(
        `SELECT id, organizer_upn, organizer_aad_id, join_url, graph_meeting_id, transcript_attempts
           FROM teams_meetings
          WHERE status = 'scheduled'
            AND organizer_upn IS NOT NULL
            AND scheduled_end_at IS NOT NULL
            AND now() > scheduled_end_at + ($1 || ' minutes')::interval
            AND transcript_attempts < $2
          ORDER BY scheduled_end_at DESC
          LIMIT $3`,
        [String(SETTLE_MINUTES), MAX_ATTEMPTS, BATCH],
      );
      for (const row of rows) {
        try {
          await processRow(pool, row);
        } catch (err) {
          console.error("[teams-transcript] row failed", {
            id: row.id,
            message: (err as { message?: string })?.message ?? String(err),
          });
        }
      }
      // BF_SERVER_MAYA_MEETING_INTEL_v1 - once a transcript exists, turn it into a
      // summary + real tasks. Separate pass so a Maya/OpenAI outage can never stop
      // transcripts being captured; the row keeps its transcript and retries later.
      await runMeetingIntel(pool);
    } catch (err) {
      console.error(
        "[teams-transcript] tick failed:",
        (err as { message?: string })?.message ?? err,
      );
    } finally {
      running = false;
    }
  };

  const kickoff = setTimeout(() => {
    void tick();
  }, KICKOFF_MS);
  const timer = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  return {
    stop: () => {
      clearTimeout(kickoff);
      clearInterval(timer);
    },
  };
}
