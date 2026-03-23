import { type SubmissionAdapter, type SubmissionPayload, type SubmissionResult } from "./SubmissionAdapter";
import { config } from "@/config";

export class EmailSubmissionAdapter implements SubmissionAdapter {
  private to: string;
  private payload: SubmissionPayload;

  constructor(params: { to: string; payload: SubmissionPayload }) {
    this.to = params.to;
    this.payload = params.payload;
  }

  async submit(_input: SubmissionPayload): Promise<SubmissionResult> {
    if (config.app.testMode === "true") {
      console.log("[TEST_MODE] EMAIL skipped");
      return {
        success: true,
        response: {
          status: "accepted",
          detail: "TEST_MODE email skipped",
          receivedAt: new Date().toISOString(),
          externalReference: "email_test_mode_skip",
        },
        failureReason: null,
        retryable: false,
      };
    }

    const now = new Date().toISOString();
    void this.payload;
    return {
      success: true,
      response: {
        status: "accepted",
        detail: `Email accepted for delivery to ${this.to}.`,
        receivedAt: now,
        externalReference: "email_stub",
      },
      failureReason: null,
      retryable: false,
    };
  }
}
