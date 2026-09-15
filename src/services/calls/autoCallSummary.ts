// BF_SERVER_AUTO_CALL_SUMMARY_v245
// A call summary used to exist only when staff clicked "Summarize call" in the
// portal. Now it is written automatically the moment Twilio Voice Intelligence
// finishes the transcript: saved on the transcript row (which the contact call
// feed already displays as transcript_summary) and as a note on the timeline.
//
// Dialer calls are conference legs, so a CallSid resolves to its conference via
// conference_participants.twilio_call_sid.
import { pool } from "../../db.js";
import { askAI } from "../../modules/ai/openai.service.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
export type SummaryDeps = { query: Query; ask: (transcript: string) => Promise<string> };

export const SUMMARY_SYSTEM_PROMPT =
  "You are a post-call assistant for a commercial-lending brokerage. Summarize this call transcript for the broker in 3-5 short bullet points, then a 'Follow-ups:' line listing any commitments, promised documents or dates. Be factual; do not invent details.";

function defaultDeps(): SummaryDeps {
  return {
    query: (sql, params) => pool.query(sql, params as any[]),
    ask: (transcript) => askAI([
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
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
): Promise<{ status: "ready" | "pending" | "none"; summary: string | null; contactId: string | null }> {
  const { rows } = await query(
    `SELECT t.status, t.voice_intelligence_summary, cf.contact_id::text AS contact_id
       FROM conference_participants p
       JOIN conferences cf ON cf.id = p.conference_id
       LEFT JOIN call_transcripts t ON t.conference_id = cf.id
      WHERE p.twilio_call_sid = $1
      ORDER BY t.updated_at DESC NULLS LAST
      LIMIT 1`,
    [callSid],
  );
  const row = rows[0];
  if (!row) return { status: "none", summary: null, contactId: null };
  const summary = String(row.voice_intelligence_summary ?? "").trim();
  if (summary) return { status: "ready", summary, contactId: row.contact_id ?? null };
  if (row.status === "failed") return { status: "none", summary: null, contactId: row.contact_id ?? null };
  return { status: "pending", summary: null, contactId: row.contact_id ?? null };
}
