import { logError } from "../../observability/logger.js";
import { respondOk } from "../../utils/respondOk.js";
import { fetchCommunications, fetchMessageFeed } from "./communications.service.js";
function logCommunicationsError(event, error) {
    logError(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
export async function handleListCommunications(req, res) {
    try {
        const contactId = typeof req.query.contactId === "string" ? req.query.contactId : null;
        const communications = await fetchCommunications({ contactId });
        respondOk(res, communications);
    }
    catch (error) {
        logCommunicationsError("communications_list_failed", error);
        respondOk(res, []);
    }
}
export async function handleListMessages(req, res) {
    try {
        const page = Number(req.query.page) || 1;
        const pageSize = Number(req.query.pageSize) || 25;
        const contactId = typeof req.query.contactId === "string" ? req.query.contactId : null;
        const messageFeed = await fetchMessageFeed({ contactId, page, pageSize });
        respondOk(res, { messages: messageFeed.messages, total: messageFeed.total }, { page, pageSize });
    }
    catch (error) {
        logCommunicationsError("communications_messages_list_failed", error);
        respondOk(res, { messages: [], total: 0 }, { page: 1, pageSize: 25 });
    }
}
