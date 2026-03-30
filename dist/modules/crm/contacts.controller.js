"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListContacts = handleListContacts;
const logger_1 = require("../../observability/logger");
const respondOk_1 = require("../../utils/respondOk");
const contacts_service_1 = require("./contacts.service");
function logCrmError(event, error) {
    (0, logger_1.logError)(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
async function handleListContacts(req, res) {
    try {
        const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
        const contacts = await (0, contacts_service_1.fetchContacts)({ companyId });
        (0, respondOk_1.respondOk)(res, contacts);
    }
    catch (error) {
        logCrmError("crm_contacts_list_failed", error);
        (0, respondOk_1.respondOk)(res, []);
    }
}
