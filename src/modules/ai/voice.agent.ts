import { pool, runQuery } from "../../db";

export type VoiceAgentState = "idle" | "listening" | "processing" | "handoff" | "closed";

export async function upsertVoiceState(
  sessionId: string,
  state: VoiceAgentState,
  event?: Record<string, unknown>
): Promise<void> {
  await runQuery(
    `insert into ai_voice_state (session_id, state, last_event, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (session_id)
     do update set state = excluded.state, last_event = excluded.last_event, updated_at = now()`,
    [sessionId, state, JSON.stringify(event ?? null)]
  );
}
