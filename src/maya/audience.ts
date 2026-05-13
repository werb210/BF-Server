// AGENT_BLOCK_v2_AUDIENCE_AND_STAFF_PIPELINE_TOOL_v1
// Audience contract. Every Maya chat request carries an explicit
// audience claim, set by the embedding repo (BF-Website,
// BF-client, BF-portal). Tools are gated per audience so visitors
// can't trigger staff actions and clients can't read pipeline data.
export type MayaAudience = "visitor" | "client" | "staff";

export const MAYA_AUDIENCE_HEADER = "x-maya-audience";

const ALL: ReadonlyArray<MayaAudience> = ["visitor", "client", "staff"];

export function parseAudience(input: unknown, fallback: MayaAudience = "visitor"): MayaAudience {
  if (typeof input !== "string") return fallback;
  const v = input.trim().toLowerCase();
  return (ALL as ReadonlyArray<string>).includes(v) ? (v as MayaAudience) : fallback;
}

// Tool whitelist per audience. Tool names are stable identifiers
// exposed to the model; the executor checks membership before
// dispatching. Anything missing from the whitelist is reported
// back to the model as "tool not available to this audience".
export const TOOLS_BY_AUDIENCE: Record<MayaAudience, ReadonlyArray<string>> = {
  visitor: ["info.products", "info.qualifications", "lead.capture", "apply.start_url"],
  client: ["application.my_status", "docs.checklist", "pgi.completion_link", "book.callback"],
  staff: [
    "pipeline.query",
    "contact.find",
    "application.summary",
    "comm.draft_email",
    "comm.send_sms",
    "call.initiate",
    "maya.audit",
  ],
};

export function isToolAllowed(audience: MayaAudience, tool: string): boolean {
  return TOOLS_BY_AUDIENCE[audience].includes(tool);
}
