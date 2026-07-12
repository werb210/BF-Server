// BF_SERVER_MAYA_MEETING_INTEL_v1
// Turn a Teams transcript into the thing staff actually want: a short summary and
// real, actionable tasks on the contact. Runs after the transcript poller captures
// the VTT. Everything below is best-effort and idempotent - a meeting that fails
// intel keeps its transcript and simply gets retried on the next tick.
import type { Pool } from "pg";
import { askAI } from "../../modules/ai/openai.service.js";

const MAX_TRANSCRIPT_CHARS = 40000;
const MAX_TASKS = 6;

type IntelRow = {
  id: string;
  silo: string;
  subject: string | null;
  contact_id: string | null;
  company_id: string | null;
  organizer_user_id: string | null;
  transcript_text: string;
};

type MayaTask = { title: string; body?: string; due_in_days?: number; priority?: string };
type MayaIntel = { summary: string; tasks: MayaTask[] };

const PRIORITIES = new Set(["NONE", "LOW", "MEDIUM", "HIGH"]);

// A VTT is mostly timestamps and cue ids. Strip them so the model spends its context
// on speech, not on "00:01:23.456 --> 00:01:25.789".
function vttToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === "WEBVTT") continue;
    if (t.includes("-->")) continue;
    if (/^[0-9a-f-]{8,}$/i.test(t)) continue; // cue identifier
    if (/^\d+$/.test(t)) continue;
    kept.push(t);
  }
  return kept.join("\n");
}

function parseIntel(raw: string): MayaIntel | null {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<MayaIntel>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    const clean: MayaTask[] = [];
    for (const t of tasks.slice(0, MAX_TASKS)) {
      const title = typeof t?.title === "string" ? t.title.trim() : "";
      if (!title) continue;
      clean.push({
        title: title.slice(0, 200),
        body: typeof t?.body === "string" ? t.body.trim().slice(0, 2000) : undefined,
        due_in_days: Number.isFinite(Number(t?.due_in_days)) ? Number(t.due_in_days) : undefined,
        priority: typeof t?.priority === "string" ? t.priority.toUpperCase() : undefined,
      });
    }
    return { summary: summary.slice(0, 4000), tasks: clean };
  } catch {
    return null;
  }
}

async function askMaya(row: IntelRow): Promise<MayaIntel | null> {
  const transcript = vttToPlainText(row.transcript_text).slice(0, MAX_TRANSCRIPT_CHARS);
  if (!transcript) return null;

  const raw = await askAI([
    {
      role: "system",
      content:
        "You are Maya, the assistant for Boreal Financial, a commercial lending marketplace. " +
        "You are given the transcript of a meeting between Boreal staff and a client or lender. " +
        "Reply with ONLY a JSON object, no prose and no markdown fences, in this exact shape:\n" +
        '{"summary":"2-4 sentences","tasks":[{"title":"short imperative","body":"one line of context","due_in_days":3,"priority":"MEDIUM"}]}\n' +
        "The summary states what was discussed and what was agreed. " +
        "Tasks are ONLY concrete commitments someone made in the meeting - if nobody committed to anything, return an empty tasks array. " +
        "Never invent a task. priority is one of NONE, LOW, MEDIUM, HIGH.",
    },
    {
      role: "user",
      content: `Meeting: ${row.subject ?? "(no subject)"}\n\nTranscript:\n${transcript}`,
    },
  ]);
  return parseIntel(raw);
}

async function writeTasks(pool: Pool, row: IntelRow, tasks: MayaTask[]): Promise<number> {
  // tasks.assignee_user_id is NOT NULL, so a meeting with no known organiser cannot
  // produce tasks. Summary still lands; we just skip task creation.
  if (!row.organizer_user_id || tasks.length === 0) return 0;

  let written = 0;
  for (const t of tasks) {
    const priority = t.priority && PRIORITIES.has(t.priority) ? t.priority : "NONE";
    const dueDays = typeof t.due_in_days === "number" && t.due_in_days >= 0 ? t.due_in_days : null;
    // source is constrained to MANUAL|SEQUENCE|WORKFLOW|IMPORT|API, so use WORKFLOW and
    // carry the meeting id in source_ref_id - that also makes the insert idempotent.
    const res = await pool.query(
      `INSERT INTO tasks
         (silo, title, body, type, priority, due_at, assignee_user_id,
          contact_id, company_id, created_by, source, source_ref_id)
       SELECT $1, $2, $3, 'TODO', $4,
              CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' days')::interval END,
              $6::uuid, $7::uuid, $8::uuid, $6::uuid, 'WORKFLOW', $9::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM tasks
           WHERE source = 'WORKFLOW' AND source_ref_id = $9::uuid
             AND title = $2 AND deleted_at IS NULL
        )`,
      [
        row.silo,
        t.title,
        t.body ?? null,
        priority,
        dueDays,
        row.organizer_user_id,
        row.contact_id,
        row.company_id,
        row.id,
      ],
    );
    written += res.rowCount ?? 0;
  }
  return written;
}

export async function runMeetingIntel(pool: Pool): Promise<void> {
  const { rows } = await pool.query<IntelRow>(
    `SELECT id, silo, subject, contact_id, company_id, organizer_user_id, transcript_text
       FROM teams_meetings
      WHERE transcript_text IS NOT NULL
        AND length(transcript_text) > 0
        AND maya_summary IS NULL
      ORDER BY transcript_fetched_at DESC
      LIMIT 5`,
  );

  for (const row of rows) {
    try {
      const intel = await askMaya(row);
      if (!intel) {
        console.error("[meeting-intel] no usable response", { id: row.id });
        continue;
      }
      const created = await writeTasks(pool, row, intel.tasks);
      await pool.query(
        `UPDATE teams_meetings
            SET maya_summary = $2,
                maya_tasks = $3::jsonb,
                status = 'summarized',
                updated_at = now()
          WHERE id = $1`,
        [row.id, intel.summary, JSON.stringify(intel.tasks)],
      );
      console.log("[meeting-intel] summarized", { id: row.id, tasks_created: created });
    } catch (err) {
      console.error("[meeting-intel] failed", {
        id: row.id,
        message: (err as { message?: string })?.message ?? String(err),
      });
    }
  }
}
