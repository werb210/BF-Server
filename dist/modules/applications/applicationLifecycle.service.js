"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApplicationStage = void 0;
exports.isTerminalApplicationStatus = isTerminalApplicationStatus;
exports.resolveNextPipelineStage = resolveNextPipelineStage;
exports.assertPipelineTransition = assertPipelineTransition;
exports.assertPipelineState = assertPipelineState;
const errors_1 = require("../../middleware/errors");
const pipelineState_1 = require("./pipelineState");
Object.defineProperty(exports, "ApplicationStage", { enumerable: true, get: function () { return pipelineState_1.ApplicationStage; } });
const TERMINAL_APPLICATION_STATUSES = new Set([
    "completed",
    "declined",
    "withdrawn",
    "expired",
]);
function normalizeStatus(status) {
    if (!status) {
        return null;
    }
    const normalized = status.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}
function isTerminalApplicationStatus(status) {
    const normalized = normalizeStatus(status);
    return normalized ? TERMINAL_APPLICATION_STATUSES.has(normalized) : false;
}
function resolveNextPipelineStage(current) {
    const allowed = pipelineState_1.LEGAL_TRANSITIONS[current] ?? [];
    if (allowed.length === 0) {
        return null;
    }
    for (const stage of pipelineState_1.PIPELINE_STATES) {
        if (allowed.includes(stage)) {
            return stage;
        }
    }
    return allowed[0] ?? null;
}
function assertPipelineTransition(params) {
    if (!(0, pipelineState_1.isPipelineState)(params.nextStage)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (!params.currentStage || !(0, pipelineState_1.isPipelineState)(params.currentStage)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (isTerminalApplicationStatus(params.status)) {
        throw new errors_1.AppError("invalid_transition", "Application is in a terminal state.", 400);
    }
    if (params.currentStage === params.nextStage) {
        return { shouldTransition: false, reason: "no_change" };
    }
    if (!pipelineState_1.LEGAL_TRANSITIONS[params.currentStage]?.includes(params.nextStage)) {
        throw new errors_1.AppError("invalid_transition", "Invalid pipeline transition.", 400);
    }
    return { shouldTransition: true, reason: "ok" };
}
function assertPipelineState(value) {
    if (!value || !(0, pipelineState_1.isPipelineState)(value)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    return value;
}
