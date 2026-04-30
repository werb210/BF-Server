import type { SubmissionAdapter, SubmissionResult } from "../SubmissionAdapter.js";
import { sendViaGraph, type GraphAttachment } from "../../../services/email/graphSendService.js";

type EmailSendInput = {
  lender: { id: string; name: string; submission_email: string | null; contact_email?: string | null };
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  attachments?: GraphAttachment[];
  cc?: string[];
};

export async function sendLenderEmail(input: EmailSendInput) {
  const to = (input.lender.submission_email ?? "").trim();
  if (!to) return { ok: false as const, provider: "graph" as const, error: `lender ${input.lender.id} has no submission_email configured` };
  const result = await sendViaGraph({ to, cc: input.cc, subject: input.subject, bodyText: input.bodyText, bodyHtml: input.bodyHtml, attachments: input.attachments });
  return result.ok
    ? { ok: true as const, provider: "graph" as const, deliveredTo: to }
    : { ok: false as const, provider: "graph" as const, error: result.error };
}

export class EmailAdapter implements SubmissionAdapter {
  constructor(private readonly params: { to: string; payload: Record<string, unknown> }) {}

  async submit(): Promise<SubmissionResult> {
    const subject = `Boreal submission package`;
    const bodyText = `A new submission package is attached.`;
    const send = await sendViaGraph({ to: this.params.to, subject, bodyText });
    if (send.ok) {
      return {
        success: true,
        response: { status: "submitted", detail: `Sent via Graph to ${this.params.to}`, receivedAt: new Date().toISOString(), externalReference: send.messageId },
        failureReason: null,
        retryable: false,
      };
    }
    return {
      success: false,
      response: { status: "failed", detail: send.error, receivedAt: new Date().toISOString(), externalReference: null },
      failureReason: send.error,
      retryable: true,
    };
  }
}

export default { send: sendLenderEmail };
