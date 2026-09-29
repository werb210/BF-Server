// BF_SERVER_BLOCK_v616 - what the automation builder offers. The portal reads this
// (GET /api/automations/catalog) so the builder and the engine can never disagree.
export const TRIGGERS = [
  { key: "application.stage_changed", label: "Application stage changes", fields: ["from_stage", "to_stage", "product_type", "requested_amount", "source"] },
  { key: "document.rejected", label: "A document is rejected", fields: ["document_type", "reason", "stage", "product_type", "requested_amount"] },
  { key: "message.inbound", label: "A client sends a message or text", fields: ["channel", "stage", "contact_tag"] },
  { key: "call.missed", label: "An inbound call is missed", fields: ["contact_tag"] },
  { key: "contact.created", label: "A contact is created", fields: ["source", "contact_tag"] },
] as const;

export const FIELDS: Record<string, { label: string; type: "text" | "number" | "stage" | "list" }> = {
  from_stage: { label: "From stage", type: "stage" },
  to_stage: { label: "To stage", type: "stage" },
  stage: { label: "Current stage", type: "stage" },
  product_type: { label: "Product type", type: "text" },
  requested_amount: { label: "Requested amount", type: "number" },
  source: { label: "Source", type: "text" },
  document_type: { label: "Document type", type: "text" },
  reason: { label: "Rejection reason", type: "text" },
  channel: { label: "Channel (sms, message)", type: "text" },
  contact_tag: { label: "Contact tag", type: "list" },
};

export const OPERATORS = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "is_set", "is_not_set"] as const;

export const ACTIONS = [
  { key: "create_task", label: "Create a task" },
  { key: "send_sms", label: "Send a text message" },
  { key: "notify_client", label: "Notify the client (app first, text fallback)" },
  { key: "notify_staff", label: "Notify staff in the portal" },
  { key: "assign_owner", label: "Assign an owner" },
  { key: "add_tag", label: "Add a tag to the contact" },
  { key: "add_note", label: "Add a note to the contact" },
  { key: "team_post", label: "Post in a Team channel" }, // BF_SERVER_TEAM_PHASE_C_v671
  { key: "wait", label: "Wait" },
  { key: "check", label: "Continue only if..." },
] as const;

export const CHECKS = [
  { key: "still_in_stage", label: "the application is still in the stage that started this" },
  { key: "documents_still_rejected", label: "the rejected document has not been replaced" },
  { key: "no_reply_since_start", label: "the client has not replied since this started" },
] as const;

export const STAGES = ["Received", "In Review", "Documents Required", "Additional Steps Required", "Off to Lender", "Offer", "Accepted", "Rejected", "Hold"];
