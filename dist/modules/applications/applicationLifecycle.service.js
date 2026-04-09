import { AppError } from "../../middleware/errors.js";
import { ApplicationStage, LEGAL_TRANSITIONS, PIPELINE_STATES, isPipelineState, } from "./pipelineState.js";
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
export function isTerminalApplicationStatus(status) {
    const normalized = normalizeStatus(status);
    return normalized ? TERMINAL_APPLICATION_STATUSES.has(normalized) : false;
}
export function resolveNextPipelineStage(current) {
    const allowed = LEGAL_TRANSITIONS[current] ?? [];
    if (allowed.length === 0) {
        return null;
    }
    for (const stage of PIPELINE_STATES) {
        if (allowed.includes(stage)) {
            return stage;
        }
    }
    return allowed[0] ?? null;
}
export function assertPipelineTransition(params) {
    if (!isPipelineState(params.nextStage)) {
        throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (!params.currentStage || !isPipelineState(params.currentStage)) {
        throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (isTerminalApplicationStatus(params.status)) {
        throw new AppError("invalid_transition", "Application is in a terminal state.", 400);
    }
    if (params.currentStage === params.nextStage) {
        return { shouldTransition: false, reason: "no_change" };
    }
    if (!LEGAL_TRANSITIONS[params.currentStage]?.includes(params.nextStage)) {
        throw new AppError("invalid_transition", "Invalid pipeline transition.", 400);
    }
    return { shouldTransition: true, reason: "ok" };
}
export function assertPipelineState(value) {
    if (!value || !isPipelineState(value)) {
        throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    return value;
}
export { ApplicationStage };
