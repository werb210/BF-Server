import { randomUUID } from "node:crypto";
import { runQuery } from "../../db.js";
export async function createVoicemail(params) {
    const result = await runQuery(`insert into voicemails (id, client_id, call_sid, recording_sid, recording_url, created_at)
     values ($1, $2, $3, $4, $5, now())
     returning id, client_id, call_sid, recording_sid, recording_url, created_at`, [randomUUID(), params.clientId ?? null, params.callSid, params.recordingSid, params.recordingUrl]);
    const row = result.rows[0];
    if (!row) {
        throw new Error("Failed to create voicemail record.");
    }
    return row;
}
