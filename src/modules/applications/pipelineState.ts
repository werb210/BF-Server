export const ApplicationStage = {
  RECEIVED:                  "Received",
  IN_REVIEW:                 "In Review",
  DOCUMENTS_REQUIRED:        "Documents Required",
  ADDITIONAL_STEPS_REQUIRED: "Additional Steps Required",
  OFF_TO_LENDER:             "Off to Lender",
  OFFER:                     "Offer",
  ACCEPTED:                  "Accepted",
  REJECTED:                  "Rejected",
} as const;

export type ApplicationStage = (typeof ApplicationStage)[keyof typeof ApplicationStage];

export const PIPELINE_STATES: ApplicationStage[] = [
  ApplicationStage.RECEIVED,
  ApplicationStage.IN_REVIEW,
  ApplicationStage.DOCUMENTS_REQUIRED,
  ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
  ApplicationStage.OFF_TO_LENDER,
  ApplicationStage.OFFER,
  ApplicationStage.ACCEPTED,
  ApplicationStage.REJECTED,
];

export type PipelineState = ApplicationStage;

export function isPipelineState(value: string): value is PipelineState {
  return (PIPELINE_STATES as readonly string[]).includes(value);
}

export const LEGAL_TRANSITIONS: Record<PipelineState, readonly PipelineState[]> = {
  [ApplicationStage.RECEIVED]: [
    ApplicationStage.IN_REVIEW,
    ApplicationStage.DOCUMENTS_REQUIRED,
  ],
  [ApplicationStage.IN_REVIEW]: [
    ApplicationStage.DOCUMENTS_REQUIRED,
    ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
    ApplicationStage.OFF_TO_LENDER,
  ],
  [ApplicationStage.DOCUMENTS_REQUIRED]: [
    ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
    ApplicationStage.OFF_TO_LENDER,
  ],
  [ApplicationStage.ADDITIONAL_STEPS_REQUIRED]: [
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

export function canTransition(
  current: PipelineState,
  next: PipelineState
): boolean {
  return (LEGAL_TRANSITIONS[current] ?? []).includes(next);
}

/**
 * Map pipeline_state display value (title-case, e.g. "Received") to the
 * applications.status column's allowed uppercase key ("RECEIVED").
 *
 * The applications_status_check constraint (migration 083) only allows:
 *   RECEIVED, DOCUMENTS_REQUIRED, IN_REVIEW, STARTUP, OFF_TO_LENDER,
 *   SUBMITTED_TO_LENDER, ACCEPTED, DECLINED
 * so we never write the title-case form to that column.
 */
export const STATUS_FROM_PIPELINE: Record<string, string> = {
  [ApplicationStage.RECEIVED]:                  "RECEIVED",
  [ApplicationStage.IN_REVIEW]:                 "IN_REVIEW",
  [ApplicationStage.DOCUMENTS_REQUIRED]:        "DOCUMENTS_REQUIRED",
  [ApplicationStage.ADDITIONAL_STEPS_REQUIRED]: "DOCUMENTS_REQUIRED",
  [ApplicationStage.OFF_TO_LENDER]:             "OFF_TO_LENDER",
  [ApplicationStage.OFFER]:                     "OFF_TO_LENDER",
  [ApplicationStage.ACCEPTED]:                  "ACCEPTED",
  [ApplicationStage.REJECTED]:                  "DECLINED",
};

export function statusFromPipeline(pipeline: ApplicationStage | string): string {
  return STATUS_FROM_PIPELINE[pipeline as string] ?? "RECEIVED";
}
