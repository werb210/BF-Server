"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGAL_TRANSITIONS = exports.PIPELINE_STATES = exports.ApplicationStage = void 0;
exports.isPipelineState = isPipelineState;
exports.canTransition = canTransition;
var ApplicationStage;
(function (ApplicationStage) {
    ApplicationStage["RECEIVED"] = "RECEIVED";
    ApplicationStage["IN_REVIEW"] = "IN_REVIEW";
    ApplicationStage["DOCUMENTS_REQUIRED"] = "DOCUMENTS_REQUIRED";
    ApplicationStage["STARTUP"] = "STARTUP";
    ApplicationStage["OFF_TO_LENDER"] = "OFF_TO_LENDER";
    ApplicationStage["OFFER"] = "OFFER";
    ApplicationStage["ACCEPTED"] = "ACCEPTED";
    ApplicationStage["REJECTED"] = "REJECTED";
})(ApplicationStage || (exports.ApplicationStage = ApplicationStage = {}));
exports.PIPELINE_STATES = [
    ApplicationStage.RECEIVED,
    ApplicationStage.IN_REVIEW,
    ApplicationStage.DOCUMENTS_REQUIRED,
    ApplicationStage.STARTUP,
    ApplicationStage.OFF_TO_LENDER,
    ApplicationStage.OFFER,
    ApplicationStage.ACCEPTED,
    ApplicationStage.REJECTED,
];
function isPipelineState(value) {
    return exports.PIPELINE_STATES.includes(value);
}
exports.LEGAL_TRANSITIONS = {
    [ApplicationStage.RECEIVED]: [
        ApplicationStage.IN_REVIEW,
        ApplicationStage.DOCUMENTS_REQUIRED,
    ],
    [ApplicationStage.IN_REVIEW]: [
        ApplicationStage.DOCUMENTS_REQUIRED,
        ApplicationStage.OFF_TO_LENDER,
    ],
    [ApplicationStage.DOCUMENTS_REQUIRED]: [ApplicationStage.OFF_TO_LENDER],
    [ApplicationStage.STARTUP]: [
        ApplicationStage.OFF_TO_LENDER,
        ApplicationStage.DOCUMENTS_REQUIRED,
    ],
    [ApplicationStage.OFF_TO_LENDER]: [
        ApplicationStage.OFFER,
        ApplicationStage.ACCEPTED,
        ApplicationStage.REJECTED,
        ApplicationStage.DOCUMENTS_REQUIRED,
    ],
    [ApplicationStage.OFFER]: [
        ApplicationStage.ACCEPTED,
        ApplicationStage.REJECTED,
        ApplicationStage.DOCUMENTS_REQUIRED,
    ],
    [ApplicationStage.ACCEPTED]: [],
    [ApplicationStage.REJECTED]: [],
};
function canTransition(current, next) {
    return (exports.LEGAL_TRANSITIONS[current] ?? []).includes(next);
}
