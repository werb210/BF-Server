// BF_SERVER_AUTO_CALL_SUMMARY_v245
// A call summary used to exist only when staff clicked "Summarize call" in the
// portal. Now it is written automatically the moment Twilio Voice Intelligence
// finishes the transcript: saved on the transcript row (which the contact call
// feed already displays as transcript_summary) and as a note on the timeline.
//
// Dialer calls are conference legs, so a CallSid resolves to its conference via
// conference_participants.twilio_call_sid.
//
// BF_SERVER_CALL_TASK_SUGGESTIONS_v253 - alongside the summary, up to three
// follow-up task suggestions are extracted and stored. They are never created
// automatically; the dialer offers each with an Add button.
import { pool } from "../../db.js";
import { askAI } from "../../modules/ai/openai.service.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
export type SummaryDeps = {
  query: Query;
  ask: (transcript: string) => Promise<string>;
  suggest?: (transcript: string) => Promise<string>;
};

export type SuggestedTask = { title: string; type: "CALL" | "EMAIL" | "SMS" | "TODO"; dueInDays: number };

export const SUMMARY_SYSTEM_PROMPT =
  "You are a post-call assistant for a commercial-lending brokerage. Summarize this call transcript for the broker in 3-5 short bullet points, then a 'Follow-ups:' line listing any commitments, promised documents or dates. Be factual; do not invent details.";

export const SUGGEST_SYSTEM_PROMPT =
  "From this commercial-lending call transcript, list follow-up tasks for the broker that are directly supported by something said on the call (a promise, a requested document, an agreed callback or date). Return ONLY a JSON array, no prose, at most 3 items, each {\"title\": string under 80 characters, \"type\": \"CALL\"|\"EMAIL\"|\"SMS\"|\"TODO\", \"dueInDays\": integer 0-30}. Return [] if nothing was committed.";

const TYPES = new Set(["CALL", "EMAIL", "SMS", "TODO"]);

/** Strict: anything malformed is dropped rather than guessed at. */
export function parseSuggestedTasks(raw: unknown): SuggestedTask[] {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
    try { value = JSON.parse(cleaned); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: SuggestedTask[] = [];
  for (const item of value) {
    const title = String((item as any)?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const type = String((item as any)?.type ?? "TODO").toUpperCase();
    const days = Number((item as any)?.dueInDays);
    if (!title) continue;
    out.push({
      title,
      type: (TYPES.has(type) ? type : "TODO") as SuggestedTask["type"],
      dueInDays: Number.isFinite(days) ? Math.min(30, Math.max(0, Math.round(days))) : 1,
    });
    if (out.length === 3) break;
  }
  return out;
}

function defaultDeps(): SummaryDeps {
  return {
    query: (sql, params) => pool.query(sql, params as any[]),
    ask: (transcript) => askAI([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `Call transcript:\n${transcript.slice(0, 6000)}` },
    ]),
    suggest: (transcript) => askAI([
      { role: "system", content: SUGGEST_SYSTEM_PROMPT },
      { role: "user", content: `Call transcript:\n${transcript.slice(0, 6000)}` },
    ]),
  };
}

/** Never throws. Returns "saved", "exists" or "skipped". */
export async function summarizeCompletedTranscript(
  conferenceId: string,
  deps: SummaryDeps = defaultDeps(),
): Promise<"saved" | "exists" | "skipped"> {
  try {
    const { rows } = await deps.query(
      `SELECT t.id AS transcript_id, t.full_text, t.voice_intelligence_summary,
              cf.contact_id::text AS contact_id, cf.silo
         FROM conferences cf
         JOIN call_transcripts t ON t.conference_id = cf.id
        WHERE cf.id = $1::uuid AND t.status = 'completed'
        ORDER BY t.updated_at DESC
        LIMIT 1`,
      [conferenceId],
    );
    const row = rows[0];
    if (!row || !String(row.full_text ?? "").trim()) return "skipped";
    if (String(row.voice_intelligence_summary ?? "").trim()) return "exists";

    const summary = String(await deps.ask(String(row.full_text))).trim();
    if (!summary) return "skipped";

    await deps.query(
      `UPDATE call_transcripts SET voice_intelligence_summary = $2, updated_at = now() WHERE id = $1`,
      [row.transcript_id, summary],
    );
    if (row.contact_id) {
      await deps.query(
        `INSERT INTO crm_notes (body, contact_id, silo) VALUES ($1, $2::uuid, $3)`,
        [`AI call summary\n${summary}`, row.contact_id, row.silo ?? "BF"],
      );
    }

    // BF_SERVER_CALL_TASK_SUGGESTIONS_v253 - a failure here never undoes the summary.
    if (deps.suggest) {
      try {
        const tasks = parseSuggestedTasks(await deps.suggest(String(row.full_text)));
        await deps.query(
          `UPDATE call_transcripts SET suggested_tasks = $2::jsonb WHERE id = $1`,
          [row.transcript_id, JSON.stringify(tasks)],
        );
      } catch (err) {
        console.error(JSON.stringify({
          event: "call_task_suggestions_failed",
          conferenceId,
          message: err instanceof Error ? err.message : String(err),
        }));
      }
    }
    return "saved";
  } catch (err) {
    console.error(JSON.stringify({
      event: "auto_call_summary_failed",
      conferenceId,
      message: err instanceof Error ? err.message : String(err),
    }));
    return "skipped";
  }
}

/** For the dialer: the summary for a finished call, looked up by its CallSid. */
export async function summaryForCallSid(
  callSid: string,
  query: Query = (sql, params) => pool.query(sql, params as any[]),
): Promise<{ status: "ready" | "pending" | "none"; summary: string | null; contactId: string | null; suggestedTasks: SuggestedTask[] }> {
  const { rows } = await query(
    `SELECT t.status, t.voice_intelligence_summary, t.suggested_tasks, cf.contact_id::text AS contact_id
       FROM conference_participants p
       JOIN conferences cf ON cf.id = p.conference_id
       LEFT JOIN call_transcripts t ON t.conference_id = cf.id
      WHERE p.twilio_call_sid = $1
      ORDER BY t.updated_at DESC NULLS LAST
      LIMIT 1`,
    [callSid],
  );
  const row = rows[0];
  if (!row) return { status: "none", summary: null, contactId: null, suggestedTasks: [] };
  const contactId = row.contact_id ?? null;
  const summary = String(row.voice_intelligence_summary ?? "").trim();
  const suggestedTasks = parseSuggestedTasks(row.suggested_tasks ?? []);
  if (summary) return { status: "ready", summary, contactId, suggestedTasks };
  if (row.status === "failed") return { status: "none", summary: null, contactId, suggestedTasks: [] };
  return { status: "pending", summary: null, contactId, suggestedTasks: [] };
}

// BF_SERVER_v821_DIALER - GET /api/calls/:callSid/summary for the iPhone dialler and the Watch.
//   -> { status: "pending" | "ready" | "none", summary?, nextSteps?: string[], taskId?, contactId?, contactName? }
// The CallSid may be any leg the app holds: the app's own leg of a conference call, the answered app/cell leg of a
// reception or direct-line call (recordedDial.ts leg-status), the caller's parent leg, or a Watch bridge id.
// Access mirrors the mid-call controls (voiceMidCall.ts userMaySee): Admin, the call's creator, or a staff
// participant of the call. Unknown calls answer "none" (nothing about them is disclosed).
export type DialerCallSummary = {
  status: "pending" | "ready" | "none";
  summary?: string;
  nextSteps?: string[];
  taskId?: string;
  contactId?: string;
  contactName?: string;
  /** BF_SERVER_v831_DIALER_POLISH - the follow-ups the outcome sheet offers (it read them from the old route). */
  suggestedTasks?: SuggestedTask[];
};

/** A recording that has not produced a summary this long after the call ended is not going to. */
export const SUMMARY_GIVE_UP_MINUTES = 20;

export const DIALER_SUMMARY_SQL = `
  SELECT cf.id::text AS conference_id, cf.contact_id, cf.created_by_user_id, cf.status AS call_status,
         cf.created_at, cf.ended_at,
         t.status AS transcript_status, t.voice_intelligence_summary, t.suggested_tasks,
         r.status AS recording_status,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name,
         EXISTS (SELECT 1 FROM conference_participants vp
                  WHERE vp.conference_id = cf.id AND vp.kind = 'staff' AND vp.identity = $2) AS viewer_on_call,
         (SELECT tk.id::text FROM tasks tk
           WHERE tk.deleted_at IS NULL
             AND (tk.source_ref_id = cf.id
                  OR (tk.source = 'CALL_DISPOSITION' AND tk.source_ref_id IN (
                        SELECT cl.id FROM call_logs cl WHERE cl.twilio_call_sid = $1)))
           ORDER BY tk.created_at DESC LIMIT 1) AS task_id
    FROM conferences cf
    LEFT JOIN LATERAL (
      SELECT ct.status, ct.voice_intelligence_summary, ct.suggested_tasks
        FROM call_transcripts ct WHERE ct.conference_id = cf.id
       ORDER BY ct.updated_at DESC LIMIT 1
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT cr.status FROM call_recordings cr WHERE cr.conference_id = cf.id
       ORDER BY cr.updated_at DESC NULLS LAST LIMIT 1
    ) r ON true
    LEFT JOIN contacts c ON c.id::text = cf.contact_id
   WHERE cf.id IN (SELECT p.conference_id FROM conference_participants p WHERE p.twilio_call_sid = $1)
      OR cf.friendly_name = 'wb_' || $1
   ORDER BY cf.created_at DESC
   LIMIT 1`;

/** Next steps: the extracted follow-up suggestions, else the summary's "Follow-ups:" line. */
export function nextStepsFrom(summary: string, suggested: SuggestedTask[]): string[] {
  if (suggested.length) return suggested.map((t) => t.title);
  const m = /follow[- ]?ups?\s*:\s*([\s\S]*)$/i.exec(summary);
  if (!m) return [];
  return m[1]
    .split(/\n|;/)
    .map((s) => s.replace(/^[\s\-*•\d.)]+/, "").trim())
    .filter((s) => s && !/^(none|n\/a|nothing)\.?$/i.test(s))
    .slice(0, 5);
}

export async function dialerCallSummary(
  callRef: string,
  viewer: { userId: string; isAdmin: boolean },
  query: Query = (sql, params) => pool.query(sql, params as any[]),
  now: Date = new Date(),
): Promise<{ access: "ok" | "forbidden"; body: DialerCallSummary }> {
  const { rows } = await query(DIALER_SUMMARY_SQL, [callRef, viewer.userId]);
  const row = rows[0];
  if (!row) return { access: "ok", body: { status: "none" } };
  const allowed = viewer.isAdmin || String(row.created_by_user_id ?? "") === viewer.userId || row.viewer_on_call === true;
  if (!allowed) return { access: "forbidden", body: { status: "none" } };

  const body: DialerCallSummary = { status: "pending" };
  if (row.contact_id) body.contactId = String(row.contact_id);
  if (row.contact_name) body.contactName = String(row.contact_name);
  if (row.task_id) body.taskId = String(row.task_id);

  const summary = String(row.voice_intelligence_summary ?? "").trim();
  if (summary) {
    body.status = "ready";
    body.summary = summary;
    const suggested = parseSuggestedTasks(row.suggested_tasks ?? []);
    body.nextSteps = nextStepsFrom(summary, suggested);
    if (suggested.length) body.suggestedTasks = suggested; // BF_SERVER_v831_DIALER_POLISH
    return { access: "ok", body };
  }
  // No summary is coming: transcription failed, nothing was recorded, or it has simply been too long.
  const endedAt = row.ended_at ? new Date(row.ended_at) : null;
  const startedAt = row.created_at ? new Date(row.created_at) : null;
  const ageMinutes = (d: Date | null) => (d ? (now.getTime() - d.getTime()) / 60000 : 0);
  const stale = (endedAt ? ageMinutes(endedAt) : ageMinutes(startedAt) - 120) > SUMMARY_GIVE_UP_MINUTES;
  if (row.transcript_status === "failed" || row.recording_status === "absent") body.status = "none";
  else if (!row.recording_status && row.call_status === "ended" && ageMinutes(endedAt) > 2) body.status = "none";
  else if (stale) body.status = "none";
  return { access: "ok", body };
}
