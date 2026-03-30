"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../middleware/errors");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const audit_service_1 = require("../modules/audit/audit.service");
const logger_1 = require("../observability/logger");
const safeHandler_1 = require("../middleware/safeHandler");
const ops_service_1 = require("../modules/ops/ops.service");
const export_service_1 = require("../modules/exports/export.service");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
function parseFormat(value) {
    if (value === "csv") {
        return "csv";
    }
    return "json";
}
function parseDate(value, label) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value !== "string") {
        throw new errors_1.AppError("invalid_range", `Invalid ${label} timestamp.`, 400);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new errors_1.AppError("invalid_range", `Invalid ${label} timestamp.`, 400);
    }
    return parsed;
}
function parseFilters(body) {
    const from = parseDate(body.from, "from");
    const to = parseDate(body.to, "to");
    if (from && to && from > to) {
        throw new errors_1.AppError("invalid_range", "from must be before to.", 400);
    }
    return {
        from,
        to,
        pipelineState: typeof body.pipelineState === "string" ? body.pipelineState : null,
        lenderId: typeof body.lenderId === "string" ? body.lenderId : null,
        productType: typeof body.productType === "string" ? body.productType : null,
    };
}
async function assertExportsEnabled() {
    if (await (0, ops_service_1.isKillSwitchEnabled)("exports")) {
        throw new errors_1.AppError("ops_kill_switch", "Exports are currently disabled.", 423);
    }
}
async function handleExport(params) {
    await (0, export_service_1.recordExportAudit)({
        actorUserId: params.actorUserId,
        exportType: params.exportType,
        filters: params.filters,
    });
    return params.run({
        filters: params.filters,
        format: params.format,
        ...(params.write ? { write: params.write } : {}),
    });
}
function fetchAuditContext(req) {
    return {
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    };
}
router.post("/pipeline", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    try {
        await assertExportsEnabled();
        const format = parseFormat(req.body?.format);
        const filters = parseFilters(req.body ?? {});
        const actorUserId = req.user?.userId ?? null;
        res.setHeader("Content-Type", format === "csv" ? "text/csv" : "application/json");
        if (format === "csv") {
            await handleExport({
                reqBody: req.body ?? {},
                actorUserId,
                exportType: "pipeline_summary",
                run: export_service_1.exportPipelineSummary,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "export_pipeline_summary",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "pipeline_summary",
                ...fetchAuditContext(req),
                success: true,
            });
            res.end();
            return;
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "pipeline_summary",
            run: export_service_1.exportPipelineSummary,
            format,
            filters,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_pipeline_summary",
            actorUserId,
            targetUserId: null,
            targetType: "export",
            targetId: "pipeline_summary",
            ...fetchAuditContext(req),
            success: true,
        });
        res["json"]({ data: rows });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_pipeline_summary",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "pipeline_summary",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        (0, logger_1.logError)("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
router.post("/lenders", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    try {
        await assertExportsEnabled();
        const format = parseFormat(req.body?.format);
        const filters = parseFilters(req.body ?? {});
        const actorUserId = req.user?.userId ?? null;
        res.setHeader("Content-Type", format === "csv" ? "text/csv" : "application/json");
        if (format === "csv") {
            await handleExport({
                reqBody: req.body ?? {},
                actorUserId,
                exportType: "lender_performance",
                run: export_service_1.exportLenderPerformance,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "export_lender_performance",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "lender_performance",
                ...fetchAuditContext(req),
                success: true,
            });
            res.end();
            return;
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "lender_performance",
            run: export_service_1.exportLenderPerformance,
            format,
            filters,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_lender_performance",
            actorUserId,
            targetUserId: null,
            targetType: "export",
            targetId: "lender_performance",
            ...fetchAuditContext(req),
            success: true,
        });
        res["json"]({ data: rows });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_lender_performance",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "lender_performance",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        (0, logger_1.logError)("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
router.post("/applications", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    try {
        await assertExportsEnabled();
        const format = parseFormat(req.body?.format);
        const filters = parseFilters(req.body ?? {});
        const actorUserId = req.user?.userId ?? null;
        res.setHeader("Content-Type", format === "csv" ? "text/csv" : "application/json");
        if (format === "csv") {
            await handleExport({
                reqBody: req.body ?? {},
                actorUserId,
                exportType: "application_volume",
                run: export_service_1.exportApplicationVolume,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "export_application_volume",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "application_volume",
                ...fetchAuditContext(req),
                success: true,
            });
            res.end();
            return;
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "application_volume",
            run: export_service_1.exportApplicationVolume,
            format,
            filters,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_application_volume",
            actorUserId,
            targetUserId: null,
            targetType: "export",
            targetId: "application_volume",
            ...fetchAuditContext(req),
            success: true,
        });
        res["json"]({ data: rows });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "export_application_volume",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "application_volume",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        (0, logger_1.logError)("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
exports.default = router;
