export type SubmissionResponse = {
  status: string;
  detail?: string;
  receivedAt: string;
  externalReference?: string | null;
};

export type SubmissionResult = {
  success: boolean;
  response: SubmissionResponse;
  failureReason: string | null;
  retryable: boolean;
};

export interface SubmissionAdapter {
  submit(applicationId: string): Promise<SubmissionResult>;
}
