import { type SubmissionAdapter, type SubmissionPayload, type SubmissionResult } from "./SubmissionAdapter.js";

export class ApiSubmissionAdapter implements SubmissionAdapter {
  private lenderId: string;
  private payload: SubmissionPayload;
  private attempt: number;

  constructor(params: { lenderId: string; payload: SubmissionPayload; attempt: number }) {
    this.lenderId = params.lenderId;
    this.payload = params.payload;
    this.attempt = params.attempt;
  }

  async submit(_input: SubmissionPayload): Promise<SubmissionResult> {
    const now = new Date().toISOString();

    if (this.lenderId === "timeout" && this.attempt === 0) {
      return {
        success: false,
        response: {
          status: "timeout",
          detail: "Lender did not respond.",
          receivedAt: now,
        },
        failureReason: "lender_timeout",
        retryable: true,
      };
    }

    const forceFailure =
      typeof this.payload === "object" &&
      this.payload !== null &&
      typeof (this.payload as { application?: { metadata?: { forceFailure?: boolean } } })
        .application?.metadata === "object" &&
      (this.payload as { application?: { metadata?: { forceFailure?: boolean } } }).application
        ?.metadata?.forceFailure;

    if (this.attempt === 0 && forceFailure) {
      return {
        success: false,
        response: {
          status: "error",
          detail: "Forced lender error.",
          receivedAt: now,
        },
        failureReason: "lender_error",
        retryable: true,
      };
    }

    return {
      success: true,
      response: {
        status: "accepted",
        receivedAt: now,
      },
      failureReason: null,
      retryable: false,
    };
  }
}
