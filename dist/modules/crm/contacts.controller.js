"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListContacts = handleListContacts;
const logger_1 = require("../../observability/logger");
const response_1 = require("../../lib/response");
const contacts_service_1 = require("./contacts.service");
function logCrmError(event, error) {
    (0, logger_1.logError)(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
async function handleListContacts(req, _res) {
    try {
        const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
        const contacts = await (0, contacts_service_1.fetchContacts)({ companyId });
        return (0, response_1.ok)(contacts, req.rid);
    }
    catch (error) {
        logCrmError("crm_contacts_list_failed", error);
        return (0, response_1.ok)([], req.rid);
    }
}
