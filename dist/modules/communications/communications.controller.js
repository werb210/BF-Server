"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListCommunications = handleListCommunications;
exports.handleListMessages = handleListMessages;
const logger_1 = require("../../observability/logger");
const response_1 = require("../../lib/response");
const communications_service_1 = require("./communications.service");
function logCommunicationsError(event, error) {
    (0, logger_1.logError)(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
async function handleListCommunications(req, _res) {
    try {
        const contactId = typeof req.query.contactId === "string" ? req.query.contactId : null;
        const communications = await (0, communications_service_1.fetchCommunications)({ contactId });
        return (0, response_1.ok)(communications, req.rid);
    }
    catch (error) {
        logCommunicationsError("communications_list_failed", error);
        return (0, response_1.ok)([], req.rid);
    }
}
async function handleListMessages(req, _res) {
    try {
        const page = Number(req.query.page) || 1;
        const pageSize = Number(req.query.pageSize) || 25;
        const contactId = typeof req.query.contactId === "string" ? req.query.contactId : null;
        const messageFeed = await (0, communications_service_1.fetchMessageFeed)({ contactId, page, pageSize });
        return (0, response_1.ok)({ messages: messageFeed.messages, total: messageFeed.total, page, pageSize }, req.rid);
    }
    catch (error) {
        logCommunicationsError("communications_messages_list_failed", error);
        return (0, response_1.ok)({ messages: [], total: 0, page: 1, pageSize: 25 }, req.rid);
    }
}
