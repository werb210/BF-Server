"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleListCompanies = handleListCompanies;
exports.handleGetCompanyById = handleGetCompanyById;
const logger_1 = require("../../observability/logger");
const respondOk_1 = require("../../utils/respondOk");
const companies_service_1 = require("./companies.service");
const toStringSafe_1 = require("../../utils/toStringSafe");
function logCrmError(event, error) {
    (0, logger_1.logError)(event, {
        error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    });
}
async function handleListCompanies(_req, res) {
    try {
        const companies = await (0, companies_service_1.fetchCompanies)();
        (0, respondOk_1.respondOk)(res, companies);
    }
    catch (error) {
        logCrmError("crm_companies_list_failed", error);
        (0, respondOk_1.respondOk)(res, []);
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
        (0, respondOk_1.respondOk)(res, company);
    }
    catch (error) {
        logCrmError("crm_companies_fetch_failed", error);
        (0, respondOk_1.respondOk)(res, []);
    }
}
