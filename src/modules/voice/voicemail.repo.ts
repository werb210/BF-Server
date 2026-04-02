import { randomUUID } from "crypto";
import { pool, runQuery } from "../../db";

export type VoicemailRecord = {
  id: string;
  client_id: string | null;
  call_sid: string;
  recording_sid: string;
  recording_url: string;
  created_at: Date;
};

export async function createVoicemail(params: {
  clientId?: string | null;
  callSid: string;
  recordingSid: string;
  recordingUrl: string;
}): Promise<VoicemailRecord> {
  const result = await runQuery<VoicemailRecord>(
    `insert into voicemails (id, client_id, call_sid, recording_sid, recording_url, created_at)
     values ($1, $2, $3, $4, $5, now())
     returning id, client_id, call_sid, recording_sid, recording_url, created_at`,
    [randomUUID(), params.clientId ?? null, params.callSid, params.recordingSid, params.recordingUrl]
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("Failed to create voicemail record.");
  }
  return row;
}
