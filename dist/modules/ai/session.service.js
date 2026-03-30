"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSession = createSession;
exports.addMessage = addMessage;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../../db");
async function createSession(source) {
    const result = await db_1.db.query(`insert into ai_sessions (id, source) values ($1, $2) returning *`, [(0, node_crypto_1.randomUUID)(), source]);
    const session = result.rows[0];
    if (!session) {
        throw new Error("Could not create AI session.");
    }
    return session;
}
async function addMessage(sessionId, role, content, metadata) {
    await db_1.db.query(`insert into ai_messages (id, session_id, role, content, metadata) values ($1, $2, $3, $4, $5::jsonb)`, [(0, node_crypto_1.randomUUID)(), sessionId, role, content, metadata ? JSON.stringify(metadata) : null]);
}
