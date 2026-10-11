// BF_SERVER_v786_WORKFLOW_GRAPH - what the v2 workflow builder offers (GET /api/automations/catalog)
// and the library of ready-made workflows (GET /api/automations/library).
import { ACTION_TYPES, convertV1Rule, DEFAULT_SETTINGS, ENGAGEMENT_FIELDS, OPERATORS, TRIGGER_TYPES, type Goal, type Graph, type Settings } from "./graph.js";
import { STAGES } from "./catalog.js";

type Field = { key: string; label: string; type: "text" | "number" | "stage" | "list" | "boolean" | "date"; options?: string[] };

export const FIELDS: Field[] = [
  { key: "first_name", label: "First name", type: "text" },
  { key: "last_name", label: "Last name", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "company", label: "Company", type: "text" },
  { key: "job_title", label: "Job title", type: "text" },
  { key: "lead_status", label: "Lead status", type: "text" },
  { key: "lifecycle_stage", label: "Lifecycle stage", type: "text" },
  { key: "contact_tag", label: "Contact tag", type: "list" },
  { key: "owner_id", label: "Contact owner", type: "text" },
  { key: "source", label: "Source", type: "text", options: ["website_form", "readiness_check", "booking", "import", "manual", "conference"] },
  { key: "stage", label: "Application stage", type: "stage", options: [...STAGES] },
  { key: "from_stage", label: "From stage", type: "stage", options: [...STAGES] },
  { key: "to_stage", label: "To stage", type: "stage", options: [...STAGES] },
  { key: "product_type", label: "Product type", type: "text" },
  { key: "requested_amount", label: "Requested amount", type: "number" },
  { key: "document_type", label: "Document type", type: "text" },
  { key: "reason", label: "Rejection reason", type: "text" },
  { key: "channel", label: "Message channel", type: "text", options: ["sms", "email", "client_portal"] },
  { key: "field", label: "Changed field", type: "text" },
  { key: "from", label: "Changed from", type: "text" },
  { key: "to", label: "Changed to", type: "text" },
  { key: "kind", label: "Booking type", type: "text", options: ["phone", "teams"] },
  { key: "url", label: "Clicked link", type: "text" },
  { key: "email.opened", label: "Opened an email since enrolling", type: "boolean" },
  { key: "email.clicked", label: "Clicked an email since enrolling", type: "boolean" },
  { key: "sms.replied", label: "Replied by text since enrolling", type: "boolean" },
  { key: "link.clicked", label: "Clicked a link since enrolling", type: "boolean" },
  { key: "booking.made", label: "Booked a call since enrolling", type: "boolean" },
];

const LABELS: Record<string, [string, string, string[]]> = {
  "contact.created": ["A contact is created", "Contacts", ["source", "contact_tag", "lead_status"]],
  "contact.field_changed": ["A contact field changes", "Contacts", ["field", "from", "to", "contact_tag"]],
  "application.created": ["An application is created", "Applications", ["product_type", "requested_amount", "source"]],
  "application.stage_changed": ["Application stage changes", "Applications", ["from_stage", "to_stage", "product_type", "requested_amount", "source"]],
  "document.uploaded": ["A document is uploaded", "Applications", ["document_type", "stage"]],
  "document.rejected": ["A document is rejected", "Applications", ["document_type", "reason", "stage"]],
  "booking.created": ["A call or meeting is booked", "Meetings", ["kind", "contact_tag"]],
  "meeting.completed": ["A conference room meeting ends", "Meetings", ["contact_tag"]],
  "message.inbound": ["A client sends a message", "Messages", ["channel", "contact_tag", "stage"]],
  "call.missed": ["An inbound call is missed", "Messages", ["contact_tag"]],
  "link.clicked": ["A tracked link is clicked", "Engagement", ["url", "contact_tag"]],
  "email.opened": ["An email is opened", "Engagement", ["contact_tag"]],
  "email.clicked": ["A link in an email is clicked", "Engagement", ["url", "contact_tag"]],
  "email.bounced": ["An email bounces", "Engagement", ["contact_tag"]],
  "email.unsubscribed": ["A contact unsubscribes", "Engagement", ["contact_tag"]],
  "date.relative": ["A date is reached (days before/after)", "Dates", ["contact_tag", "lead_status"]],
  "no_reply": ["No reply after a number of days", "Messages", ["contact_tag", "lead_status"]],
  "manual": ["Enrolled by staff", "Manual", []],
};

type Param = { key: string; label: string; type: string; required?: boolean; options?: string[] };
const ACTION_INFO: Record<string, [string, string, Param[]]> = {
  send_email: ["Send an email", "Messages", [{ key: "templateId", label: "Email template", type: "template_email", required: true }, { key: "fromMailbox", label: "From mailbox", type: "text" }]],
  send_sms: ["Send a text", "Messages", [{ key: "templateId", label: "Text template", type: "template_sms" }, { key: "body", label: "Message", type: "textarea" }, { key: "kind", label: "Kind", type: "select", options: ["marketing", "transactional"], required: true }]],
  notify_client: ["Notify the client (app first, text fallback)", "Messages", [{ key: "title", label: "Title", type: "text" }, { key: "body", label: "Message", type: "textarea", required: true }]],
  notify_staff: ["Notify staff", "Internal", [{ key: "channel", label: "Channel", type: "select", options: ["in_app", "email", "sms", "team"], required: true }, { key: "to", label: "Who", type: "user_or_owner", required: true }, { key: "message", label: "Message", type: "textarea", required: true }]],
  team_post: ["Post in a Team channel", "Internal", [{ key: "channel", label: "Channel", type: "text", required: true }, { key: "body", label: "Message", type: "textarea", required: true }]],
  rotate_owner: ["Rotate the owner (round robin)", "Owner", [{ key: "userIds", label: "People (none = all active staff)", type: "users" }]],
  assign_owner: ["Assign an owner", "Owner", [{ key: "userId", label: "Owner", type: "user", required: true }]],
  create_task: ["Create a task", "Internal", [{ key: "title", label: "Title", type: "text", required: true }, { key: "type", label: "Type", type: "select", options: ["CALL", "EMAIL", "SMS", "TODO"] }, { key: "priority", label: "Priority", type: "select", options: ["NONE", "LOW", "MEDIUM", "HIGH"] }, { key: "dueInHours", label: "Due in (hours)", type: "number" }, { key: "assignee", label: "Assignee", type: "user_or_owner" }]],
  add_note: ["Add a note", "Contact", [{ key: "body", label: "Note", type: "textarea", required: true }]],
  set_contact_field: ["Set a contact field", "Contact", [{ key: "field", label: "Field", type: "select", options: ["first_name", "last_name", "name", "email", "phone", "job_title", "company_name", "lead_status", "lifecycle_stage", "status", "role"], required: true }, { key: "value", label: "Value", type: "text" }]],
  set_application_stage: ["Move the application to a stage", "Applications", [{ key: "stage", label: "Stage", type: "select", options: [...STAGES], required: true }]],
  add_tag: ["Add a tag", "Contact", [{ key: "tag", label: "Tag", type: "text", required: true }]],
  remove_tag: ["Remove a tag", "Contact", [{ key: "tag", label: "Tag", type: "text", required: true }]],
  add_to_list: ["Add to a list", "Contact", [{ key: "listId", label: "List", type: "list", required: true }]],
  remove_from_list: ["Remove from a list", "Contact", [{ key: "listId", label: "List", type: "list", required: true }]],
  webhook: ["Send a webhook", "Advanced", [{ key: "url", label: "URL (https)", type: "text", required: true }, { key: "method", label: "Method", type: "select", options: ["POST"] }, { key: "includeFields", label: "Fields", type: "fields" }]],
  enroll_workflow: ["Enroll in another workflow", "Advanced", [{ key: "workflowId", label: "Workflow", type: "workflow", required: true }]],
};

export function catalogStatic() {
  return {
    triggers: TRIGGER_TYPES.map((type) => ({ type, label: LABELS[type]![0], group: LABELS[type]![1], filterFields: LABELS[type]![2] })),
    actions: ACTION_TYPES.map((action) => ({ action, label: ACTION_INFO[action]![0], group: ACTION_INFO[action]![1], params: ACTION_INFO[action]![2] })),
    fields: FIELDS,
    operators: [...OPERATORS],
    engagementFields: [...ENGAGEMENT_FIELDS],
    stages: [...STAGES],
  };
}

// ---- library ------------------------------------------------------------------------
export type LibraryItem = { key: string; name: string; description: string; graph: Graph; settings: Settings; goal: Goal };

const V1_SYSTEM = [
  { key: "starter_funded", name: "Funded: thank you, referral ask, insurance", description: "The application moves to Accepted: thank the client, flag an Insurance (PGI) conversation, and 7 days later ask for a referral (with consent).",
    trigger_type: "application.stage_changed", conditions: [{ field: "to_stage", op: "eq", value: "Accepted" }], reenroll: "never",
    steps: [{ type: "notify_client", title: "Congratulations", body: "Congratulations {{first_name}} - your financing is complete. Thank you for choosing Boreal." }, { type: "create_task", title: "Discuss personal guarantee insurance (PGI) with {{full_name}}", taskType: "CALL", priority: "MEDIUM", dueHours: 48, assignTo: "owner" }, { type: "wait", amount: 7, unit: "days" }, { type: "send_sms", purpose: "marketing", body: "Hi {{first_name}}, glad we could help. If you know a business owner who needs financing, reply with their name - we look after referrals." }] },
  { key: "starter_missed_call", name: "Missed inbound call", description: "A client call is missed: create a callback task and text them that we will call back shortly.",
    trigger_type: "call.missed", conditions: [], reenroll: "always",
    steps: [{ type: "create_task", title: "Call back {{full_name}}", taskType: "CALL", priority: "HIGH", dueHours: 0, assignTo: "owner" }, { type: "send_sms", purpose: "transactional", body: "Sorry we missed your call - we will call you back shortly. - Boreal Financial" }] },
  { key: "starter_new_lead", name: "New website lead", description: "Someone fills in the website contact form or the readiness check: assign an owner in turn, send an intro text (with consent) and create a call task due within the hour.",
    trigger_type: "contact.created", conditions: [{ field: "source", op: "in", value: ["website", "website_form", "readiness_check"] }], reenroll: "never",
    steps: [{ type: "assign_owner", mode: "round_robin", userIds: [] }, { type: "send_sms", purpose: "marketing", body: "Hi {{first_name}}, thanks for reaching out to Boreal Financial. {{owner_name}} will call you shortly." }, { type: "create_task", title: "Call new lead {{full_name}}", taskType: "CALL", priority: "HIGH", dueHours: 1, assignTo: "owner" }] },
  { key: "starter_offer_unsigned", name: "Offer not accepted after 48 hours", description: "The application moves to Offer. If it is still at Offer 48 hours later, remind the client and give the owner a task.",
    trigger_type: "application.stage_changed", conditions: [{ field: "to_stage", op: "eq", value: "Offer" }], reenroll: "always",
    steps: [{ type: "wait", amount: 48, unit: "hours" }, { type: "check", check: "still_in_stage" }, { type: "notify_client", title: "Your offer is waiting", body: "Hi {{first_name}}, your offer is ready to review and sign in the Boreal app." }, { type: "create_task", title: "Offer not signed after 48 hours", taskType: "CALL", priority: "HIGH", dueHours: 4, assignTo: "owner" }] },
];

export function libraryItems(): LibraryItem[] {
  const fromV1 = V1_SYSTEM.map((r) => ({ key: r.key, name: r.name, description: r.description, ...convertV1Rule(r) }));
  const booked: LibraryItem = {
    key: "booked_call_follow_up", name: "Booked call follow-up",
    description: "A client books a call: the owner gets a prep task right away. A day after the call, if they have not started an application, they get a text with the link.",
    graph: {
      triggers: [{ type: "booking.created", filters: [], filterLogic: "all" }],
      startNodeId: "prep",
      nodes: {
        prep: { id: "prep", kind: "action", action: "create_task", params: { title: "Prepare for booked call with {{full_name}}", type: "CALL", priority: "HIGH", dueInHours: 1, assignee: "owner" }, next: "wait" },
        wait: { id: "wait", kind: "delay", mode: "duration", params: { amount: 1, unit: "days" }, next: "check" },
        check: { id: "check", kind: "branch", branches: [{ id: "has_app", label: "Already applied", logic: "all", conditions: [{ field: "stage", op: "is_set" }], next: null }], noneNext: "text" },
        text: { id: "text", kind: "action", action: "send_sms", params: { kind: "marketing", body: "Hi {{first_name}}, thanks for speaking with {{owner_name}}. When you are ready, you can apply here: {{application_link}}" }, next: null },
      },
    },
    settings: { ...DEFAULT_SETTINGS, reenroll: "always" },
    goal: null,
  };
  const noReply: LibraryItem = {
    key: "no_reply_3_days", name: "No reply after 3 days",
    description: "We messaged a contact 3 days ago and they have not replied: the owner gets a follow-up call task and a portal notice. Ends as soon as they reply.",
    graph: {
      triggers: [{ type: "no_reply", filters: [], filterLogic: "all", params: { days: 3 } }],
      startNodeId: "task",
      nodes: {
        task: { id: "task", kind: "action", action: "create_task", params: { title: "No reply from {{full_name}} in 3 days - follow up", type: "CALL", priority: "MEDIUM", dueInHours: 24, assignee: "owner" }, next: "notify" },
        notify: { id: "notify", kind: "action", action: "notify_staff", params: { channel: "in_app", to: "owner", message: "{{full_name}} has not replied in 3 days." }, next: null },
      },
    },
    settings: { ...DEFAULT_SETTINGS, reenroll: "after_complete" },
    goal: { logic: "any", conditions: [{ field: "sms.replied", op: "eq", value: true }] },
  };
  return [...fromV1, booked, noReply];
}
