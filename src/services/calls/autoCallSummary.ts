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
