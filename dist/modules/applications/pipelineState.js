export var ApplicationStage;
(function (ApplicationStage) {
    ApplicationStage["RECEIVED"] = "RECEIVED";
    ApplicationStage["IN_REVIEW"] = "IN_REVIEW";
    ApplicationStage["DOCUMENTS_REQUIRED"] = "DOCUMENTS_REQUIRED";
    ApplicationStage["STARTUP"] = "STARTUP";
    ApplicationStage["OFF_TO_LENDER"] = "OFF_TO_LENDER";
    ApplicationStage["OFFER"] = "OFFER";
    ApplicationStage["ACCEPTED"] = "ACCEPTED";
    ApplicationStage["REJECTED"] = "REJECTED";
})(ApplicationStage || (ApplicationStage = {}));
export const PIPELINE_STATES = [
    ApplicationStage.RECEIVED,
    ApplicationStage.IN_REVIEW,
    ApplicationStage.DOCUMENTS_REQUIRED,
    ApplicationStage.STARTUP,
    ApplicationStage.OFF_TO_LENDER,
    ApplicationStage.OFFER,
    ApplicationStage.ACCEPTED,
    ApplicationStage.REJECTED,
];
export function isPipelineState(value) {
    return PIPELINE_STATES.includes(value);
}
export const LEGAL_TRANSITIONS = {
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
export function canTransition(current, next) {
    return (LEGAL_TRANSITIONS[current] ?? []).includes(next);
}
