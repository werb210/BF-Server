import { randomUUID } from "node:crypto";
import { db } from "../../db.js";
export async function createSession(source) {
    const result = await db.query(`insert into ai_sessions (id, source) values ($1, $2) returning *`, [randomUUID(), source]);
    const session = result.rows[0];
    if (!session) {
        throw new Error("Could not create AI session.");
    }
    return session;
}
export async function addMessage(sessionId, role, content, metadata) {
    await db.query(`insert into ai_messages (id, session_id, role, content, metadata) values ($1, $2, $3, $4, $5::jsonb)`, [randomUUID(), sessionId, role, content, metadata ? JSON.stringify(metadata) : null]);
}
