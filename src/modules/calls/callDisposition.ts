// BF_SERVER_CALL_DISPOSITION_v145
// Shared post-call outcome vocabulary and downstream workflow rules.

export const CALL_DISPOSITIONS = [
  "connected",
  "left_voicemail",
  "no_answer",
  "follow_up",
  "not_interested",
  "do_not_contact",
  "demo_booked",
  "documents_promised",
  "needs_lender_review",
] as const;

export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export function isCallDisposition(value: unknown): value is CallDisposition {
  return typeof value === "string" && (CALL_DISPOSITIONS as readonly string[]).includes(value);
}

export type FollowUpRule = { label: string; days: number };

export const DISPOSITION_FOLLOWUP: Readonly<Record<string, FollowUpRule>> = {
  follow_up: { label: "Follow up on call", days: 2 },
  documents_promised: { label: "Collect promised documents", days: 3 },
  needs_lender_review: { label: "Send file for lender review", days: 1 },
  demo_booked: { label: "Prepare for booked demo", days: 1 },
};

export function followUpFor(disposition: string): FollowUpRule | null {
  return DISPOSITION_FOLLOWUP[disposition] ?? null;
}

export function timelineLabel(disposition: string): string {
  return "Call outcome: " + disposition.replace(/_/g, " ");
}

export function suppressesOutreach(disposition: string): boolean {
  return disposition === "do_not_contact";
}

export type DispositionPlan = {
  disposition: CallDisposition;
  followUp: FollowUpRule | null;
  timelineNote: string;
  suppressOutreach: boolean;
};

export function planForDisposition(value: unknown): DispositionPlan | null {
  if (!isCallDisposition(value)) return null;
  return {
    disposition: value,
    followUp: followUpFor(value),
    timelineNote: timelineLabel(value),
    suppressOutreach: suppressesOutreach(value),
  };
}
