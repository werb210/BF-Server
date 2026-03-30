"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchCommunications = fetchCommunications;
exports.fetchMessageFeed = fetchMessageFeed;
const communications_repo_1 = require("./communications.repo");
function buildParticipant(params) {
    if (!params.recordId) {
        return null;
    }
    return {
        id: params.recordId,
        email: params.email ?? null,
        phone: params.phone ?? null,
    };
}
function normalizeCommunication(row) {
    const contact = buildParticipant({
        recordId: row.contact_record_id,
        email: row.contact_email,
        phone: row.contact_phone,
    });
    const user = buildParticipant({
        recordId: row.user_record_id,
        email: row.user_email,
        phone: row.user_phone,
    });
    return {
        id: row.id,
        type: row.type ?? null,
        direction: row.direction ?? "unknown",
        status: row.status ?? "unknown",
        duration: row.duration ?? 0,
        twilioSid: row.twilio_sid ?? null,
        contactId: row.contact_id ?? null,
        userId: row.user_id ?? null,
        createdAt: row.created_at ?? null,
        contact,
        user,
    };
}
function normalizeMessage(row) {
    return {
        ...normalizeCommunication(row),
        body: row.body ?? null,
    };
}
async function fetchCommunications(params) {
    const rows = await (0, communications_repo_1.listCommunications)({
        ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
    });
    if (rows.length === 0) {
        return [];
    }
    return rows.map((row) => normalizeCommunication(row));
}
async function fetchMessageFeed(params) {
    const rows = await (0, communications_repo_1.listMessages)({
        ...(params.contactId !== undefined ? { contactId: params.contactId } : {}),
        page: params.page,
        pageSize: params.pageSize,
    });
    if (rows.length === 0) {
        return { messages: [], total: 0 };
    }
    const total = rows[0]?.total_count ?? 0;
    return {
        messages: rows.map((row) => normalizeMessage(row)),
        total,
    };
}
