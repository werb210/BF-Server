import { logError } from "../../observability/logger.js";
import { respondOk } from "../../utils/respondOk.js";
import { fetchCompanies, fetchCompanyById } from "./companies.service.js";
import { toStringSafe } from "../../utils/toStringSafe.js";
function logCrmError(event, error) {
    logError(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
export async function handleListCompanies(_req, res) {
    try {
        const companies = await fetchCompanies();
        respondOk(res, companies);
    }
    catch (error) {
        logCrmError("crm_companies_list_failed", error);
        respondOk(res, []);
    }
}
export async function handleGetCompanyById(req, res) {
    try {
        const companyId = toStringSafe(req.params.id);
        if (!companyId) {
            res.status(400).json({
                code: "validation_error",
                message: "Company id is required.",
                requestId: res.locals.requestId ?? "unknown",
            });
            return;
        }
        const company = await fetchCompanyById(companyId);
        if (!company) {
            res.status(404).json({
                code: "not_found",
                message: "Company not found.",
                requestId: res.locals.requestId ?? "unknown",
            });
            return;
        }
        respondOk(res, company);
    }
    catch (error) {
        logCrmError("crm_companies_fetch_failed", error);
        respondOk(res, []);
    }
}
