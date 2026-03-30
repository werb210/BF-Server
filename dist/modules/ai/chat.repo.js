"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSession = createSession;
exports.fetchSessionById = fetchSessionById;
exports.updateSessionStatus = updateSessionStatus;
exports.addMessage = addMessage;
exports.listMessagesBySession = listMessagesBySession;
exports.fetchMessageCount = fetchMessageCount;
exports.listSessionsByStatus = listSessionsByStatus;
const collectionSafe_1 = require("../../utils/collectionSafe");
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const TABLE_CACHE_TTL_MS = 10 * 60 * 1000;
const tableColumnCache = new Map();
function setTableColumnsCache(table, columns) {
    tableColumnCache.set(table, { columns, expiresAt: Date.now() + TABLE_CACHE_TTL_MS });
}
async function fetchTableColumns(table) {
    const cached = tableColumnCache.get(table);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.columns;
    }
    if (cached) {
        tableColumnCache.delete(table);
    }
    const { rows } = await db_1.pool.query(`select column_name
     from information_schema.columns
     where table_schema = 'public' and table_name = $1`, [table]);
    const columns = (0, collectionSafe_1.toStringSet)(rows.map((row) => row.column_name));
    setTableColumnsCache(table, columns);
    return columns;
}
async function createSession(params) {
    const columns = await fetchTableColumns("chat_sessions");
    const id = (0, crypto_1.randomUUID)();
    if (columns.has("user_type") && !columns.has("channel")) {
        const { rows } = await db_1.pool.query(`insert into chat_sessions (id, user_type, status, source)
       values ($1, 'guest', 'active', $2)
       returning id, source, status, null::uuid as lead_id`, [id, params.source]);
        const legacyCreated = rows[0];
        if (!legacyCreated) {
            throw new Error("Could not create chat session.");
        }
        return {
            id: legacyCreated.id,
            source: legacyCreated.source ?? params.source,
            channel: params.channel ?? "text",
            status: "ai",
            leadId: legacyCreated.lead_id,
        };
    }
    const rows = await db_1.pool.query(`insert into chat_sessions (id, source, channel, status, lead_id)
     values ($1, $2, $3, 'ai', $4)
     returning id, source, channel, status, lead_id`, [id, params.source, params.channel ?? "text", params.leadId ?? null]).then((res) => res.rows).catch(async () => {
        const legacy = await db_1.pool.query(`insert into chat_sessions (id, user_type, status, source)
       values ($1, 'guest', 'active', $2)
       returning id, source, status`, [id, params.source]);
        return legacy.rows.map((row) => ({
            id: row.id,
            source: row.source ?? params.source,
            channel: params.channel ?? "text",
            status: "ai",
            lead_id: null,
        }));
    });
    const created = rows[0];
    if (!created) {
        throw new Error("Could not create chat session.");
    }
    return {
        id: created.id,
        source: created.source,
        channel: created.channel,
        status: created.status,
        leadId: created.lead_id,
    };
}
async function fetchSessionById(sessionId) {
    const { rows } = await db_1.pool.query(`select id, source, channel, status, lead_id
     from chat_sessions where id = $1`, [sessionId]);
    const session = rows[0];
    if (!session) {
        return null;
    }
    return {
        id: session.id,
        source: session.source,
        channel: session.channel,
        status: session.status,
        leadId: session.lead_id,
    };
}
async function updateSessionStatus(sessionId, status) {
    let result = await db_1.pool.query(`update chat_sessions set status = $2, updated_at = now() where id = $1`, [sessionId, status]).catch(() => null);
    if (!result && status === "human") {
        result = await db_1.pool.query(`update chat_sessions set status = 'escalated', updated_at = now() where id = $1`, [sessionId]);
    }
    if (!result || (result.rowCount ?? 0) === 0) {
        throw new Error("chat_session_not_found");
    }
}
async function addMessage(params) {
    const columns = await fetchTableColumns("chat_messages");
    const payload = params.metadata ? JSON.stringify(params.metadata) : null;
    if (columns.has("content")) {
        await db_1.pool.query(`insert into chat_messages (id, session_id, role, message, content, metadata)
       values ($1, $2, $3, $4, $4, $5::jsonb)`, [(0, crypto_1.randomUUID)(), params.sessionId, params.role, params.message, payload]);
        return;
    }
    await db_1.pool.query(`insert into chat_messages (id, session_id, role, message, metadata)
     values ($1, $2, $3, $4, $5::jsonb)`, [(0, crypto_1.randomUUID)(), params.sessionId, params.role, params.message, payload]);
}
async function listMessagesBySession(sessionId) {
    const { rows } = await db_1.pool.query(`select id, session_id, role, message, content, metadata, created_at
     from chat_messages
     where session_id = $1
     order by created_at asc`, [sessionId]);
    return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        message: row.message ?? row.content ?? "",
        metadata: row.metadata,
        createdAt: row.created_at,
    }));
}
async function fetchMessageCount(sessionId) {
    const { rows } = await db_1.pool.query(`select count(*)::text as count from chat_messages where session_id = $1`, [sessionId]);
    return Number(rows[0]?.count ?? "0");
}
async function listSessionsByStatus(status) {
    const mappedStatus = status === "human" ? ["human", "escalated"] : [status];
    const { rows } = await db_1.pool.query(`select id, source, channel, status, lead_id
     from chat_sessions
     where status = any($1)
     order by updated_at desc`, [mappedStatus]);
    return rows.map((row) => ({
        id: row.id,
        source: row.source,
        channel: row.channel,
        status: row.status,
        leadId: row.lead_id,
    }));
}
