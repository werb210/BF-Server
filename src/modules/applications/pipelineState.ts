export const ApplicationStage = {
  RECEIVED:                  "Received",
  IN_REVIEW:                 "In Review",
  DOCUMENTS_REQUIRED:        "Documents Required",
  ADDITIONAL_STEPS_REQUIRED: "Additional Steps Required",
  OFF_TO_LENDER:             "Off to Lender",
  OFFER:                     "Offer",
  ACCEPTED:                  "Accepted",
  REJECTED:                  "Rejected",
  // BF_SERVER_FRAUD_HOLD_v48 - parking stages. Neither deletes anything; both
  // take the file out of the numbers. See reportingScope.ts for which counts.
  FRAUD:                     "Fraud",
  HOLD:                      "Hold",
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
  ApplicationStage.FRAUD,
  ApplicationStage.HOLD,
];

// BF_SERVER_FRAUD_HOLD_v48 - stages a file can be parked in and brought back
// from. Kept separate from the board's working stages.
export const PARKED_STATES: ApplicationStage[] = [
  ApplicationStage.FRAUD,
  ApplicationStage.HOLD,
];

export function isParkedState(value: string | null | undefined): boolean {
  return (PARKED_STATES as readonly string[]).includes(String(value ?? ""));
}

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
  [ApplicationStage.FRAUD]: [],
  [ApplicationStage.HOLD]: [],
};

// BF_SERVER_FRAUD_HOLD_v48 - every working stage can be parked, and a parked
// file can be restored to any working stage (in practice, the one it left).
const WORKING_STATES: ApplicationStage[] = PIPELINE_STATES.filter((stage) => !isParkedState(stage));

for (const working of WORKING_STATES) {
  (LEGAL_TRANSITIONS as Record<PipelineState, PipelineState[]>)[working] = [
    ...(LEGAL_TRANSITIONS[working] ?? []),
    ApplicationStage.FRAUD,
    ApplicationStage.HOLD,
  ];
}
for (const parked of PARKED_STATES) {
  (LEGAL_TRANSITIONS as Record<PipelineState, PipelineState[]>)[parked] = [...WORKING_STATES];
}

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
  // BF_SERVER_FRAUD_HOLD_v48 - applications_status_check does not allow a
  // Fraud/Hold key, so map to the nearest permitted value. The real stage lives
  // in pipeline_state, and parked_previous_stage carries what to restore.
  [ApplicationStage.FRAUD]:                     "DECLINED",
  [ApplicationStage.HOLD]:                      "IN_REVIEW",
};

export function statusFromPipeline(pipeline: ApplicationStage | string): string {
  return STATUS_FROM_PIPELINE[pipeline as string] ?? "RECEIVED";
}
