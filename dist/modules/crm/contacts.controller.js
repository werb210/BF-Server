import { logError } from "../../observability/logger.js";
import { respondOk } from "../../utils/respondOk.js";
import { fetchContacts } from "./contacts.service.js";
function logCrmError(event, error) {
    logError(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
export async function handleListContacts(req, res) {
    try {
        const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
        const contacts = await fetchContacts({ companyId });
        respondOk(res, contacts);
    }
    catch (error) {
        logCrmError("crm_contacts_list_failed", error);
        respondOk(res, []);
    }
}
