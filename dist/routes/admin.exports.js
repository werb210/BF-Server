import { Router } from "express";
import { AppError } from "../middleware/errors.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logError } from "../observability/logger.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { isKillSwitchEnabled } from "../modules/ops/ops.service.js";
import { exportApplicationVolume, exportLenderPerformance, exportPipelineSummary, recordExportAudit, } from "../modules/exports/export.service.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));
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
        throw new AppError("invalid_range", `Invalid ${label} timestamp.`, 400);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new AppError("invalid_range", `Invalid ${label} timestamp.`, 400);
    }
    return parsed;
}
function parseFilters(body) {
    const from = parseDate(body.from, "from");
    const to = parseDate(body.to, "to");
    if (from && to && from > to) {
        throw new AppError("invalid_range", "from must be before to.", 400);
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
    if (await isKillSwitchEnabled("exports")) {
        throw new AppError("ops_kill_switch", "Exports are currently disabled.", 423);
    }
}
async function handleExport(params) {
    await recordExportAudit({
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
router.post("/pipeline", safeHandler(async (req, res, next) => {
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
                run: exportPipelineSummary,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await recordAuditEvent({
                action: "export_pipeline_summary",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "pipeline_summary",
                ...fetchAuditContext(req),
                success: true,
            });
            return res.status(200).json({ status: "ok" });
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "pipeline_summary",
            run: exportPipelineSummary,
            format,
            filters,
        });
        await recordAuditEvent({
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
        await recordAuditEvent({
            action: "export_pipeline_summary",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "pipeline_summary",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        logError("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
router.post("/lenders", safeHandler(async (req, res, next) => {
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
                run: exportLenderPerformance,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await recordAuditEvent({
                action: "export_lender_performance",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "lender_performance",
                ...fetchAuditContext(req),
                success: true,
            });
            return res.status(200).json({ status: "ok" });
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "lender_performance",
            run: exportLenderPerformance,
            format,
            filters,
        });
        await recordAuditEvent({
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
        await recordAuditEvent({
            action: "export_lender_performance",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "lender_performance",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        logError("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
router.post("/applications", safeHandler(async (req, res, next) => {
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
                run: exportApplicationVolume,
                format,
                filters,
                write: (chunk) => res.write(chunk),
            });
            await recordAuditEvent({
                action: "export_application_volume",
                actorUserId,
                targetUserId: null,
                targetType: "export",
                targetId: "application_volume",
                ...fetchAuditContext(req),
                success: true,
            });
            return res.status(200).json({ status: "ok" });
        }
        const rows = await handleExport({
            reqBody: req.body ?? {},
            actorUserId,
            exportType: "application_volume",
            run: exportApplicationVolume,
            format,
            filters,
        });
        await recordAuditEvent({
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
        await recordAuditEvent({
            action: "export_application_volume",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "export",
            targetId: "application_volume",
            ...fetchAuditContext(req),
            success: false,
        });
        const message = err instanceof Error ? err.message : "unknown error";
        logError("export_failed", { code: "export_failed", message });
        next(err);
    }
}));
export default router;
