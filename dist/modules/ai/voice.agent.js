"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertVoiceState = upsertVoiceState;
const db_1 = require("../../db");
async function upsertVoiceState(sessionId, state, event) {
    await (0, db_1.runQuery)(`insert into ai_voice_state (session_id, state, last_event, updated_at)
     values ($1, $2, $3::jsonb, now())
     on conflict (session_id)
     do update set state = excluded.state, last_event = excluded.last_event, updated_at = now()`, [sessionId, state, JSON.stringify(event ?? null)]);
}
