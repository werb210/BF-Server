"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListCompanies = handleListCompanies;
exports.handleGetCompanyById = handleGetCompanyById;
const logger_1 = require("../../observability/logger");
const response_1 = require("../../lib/response");
const companies_service_1 = require("./companies.service");
const toStringSafe_1 = require("../../utils/toStringSafe");
function logCrmError(event, error) {
    (0, logger_1.logError)(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
async function handleListCompanies(req, _res) {
    try {
        const companies = await (0, companies_service_1.fetchCompanies)();
        return (0, response_1.ok)(companies, req.rid);
    }
    catch (error) {
        logCrmError("crm_companies_list_failed", error);
        return (0, response_1.ok)([], req.rid);
    }
}
async function handleGetCompanyById(req, res) {
    try {
        const companyId = (0, toStringSafe_1.toStringSafe)(req.params.id);
        if (!companyId) {
            res.status(400).json({
                code: "validation_error",
                message: "Company id is required.",
                requestId: res.locals.requestId ?? "unknown",
            });
            return;
        }
        const company = await (0, companies_service_1.fetchCompanyById)(companyId);
        if (!company) {
            res.status(404).json({
                code: "not_found",
                message: "Company not found.",
                requestId: res.locals.requestId ?? "unknown",
            });
            return;
        }
        return (0, response_1.ok)(company, req.rid);
    }
    catch (error) {
        logCrmError("crm_companies_fetch_failed", error);
        return (0, response_1.ok)([], req.rid);
    }
}
