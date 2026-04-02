"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVoicemail = createVoicemail;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function createVoicemail(params) {
    const result = await (0, db_1.runQuery)(`insert into voicemails (id, client_id, call_sid, recording_sid, recording_url, created_at)
     values ($1, $2, $3, $4, $5, now())
     returning id, client_id, call_sid, recording_sid, recording_url, created_at`, [(0, crypto_1.randomUUID)(), params.clientId ?? null, params.callSid, params.recordingSid, params.recordingUrl]);
    const row = result.rows[0];
    if (!row) {
        throw new Error("Failed to create voicemail record.");
    }
    return row;
}
