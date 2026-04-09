import { randomUUID } from "node:crypto";
import { pushLeadToCRM } from "./crmWebhook.js";

export type CRMLeadInput = {
  companyName: string;
  fullName: string;
  email: string;
  phone: string;
  industry?: string;
  source: string;
  metadata?: Record<string, unknown>;
};

export async function createCRMLead(lead: CRMLeadInput): Promise<{ id: string }> {
  const id = randomUUID();
  await pushLeadToCRM({
    id,
    type: "lead",
    ...lead,
  });

  return { id };
}
