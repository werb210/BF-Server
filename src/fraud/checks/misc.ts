// BF_SERVER_v846_FRAUD - checks 12 (network), 14 (inside-job events on this file) and 15 (call voice check): the pure
// evaluation of what the worker gathered.
import { notApplicable, notConfigured, result, type CheckResult, type Reason } from "../types.js";

export type NetworkNode = { id: string; type: "application" | "phone" | "email" | "address" | "bank_account" | "device" | "ip" | "director"; label: string; fraud?: boolean; current?: boolean };
export type NetworkEdge = { from: string; to: string };
export type Network = { nodes: NetworkNode[]; edges: NetworkEdge[] };

const LINK_TEXT: Record<NetworkNode["type"], string> = {
  application: "application", phone: "phone number", email: "email address", address: "address", bank_account: "bank account",
  device: "device", ip: "internet connection", director: "director",
};

export function evaluateNetwork(net: Network, currentId: string): CheckResult {
  const others = net.nodes.filter((n) => n.type === "application" && n.id !== `app:${currentId}`);
  if (!others.length) return result([{ code: "no_links", severity: "info", text: "No other application shares a phone, email, address, bank account, device or director with this one." }], { linked_applications: 0 });
  const viaFor = (appNodeId: string) => {
    const ids = net.edges.filter((e) => e.from === appNodeId || e.to === appNodeId).map((e) => (e.from === appNodeId ? e.to : e.from));
    const shared = net.nodes.filter((n) => ids.includes(n.id) && n.type !== "application" && net.edges.some((e) => (e.from === `app:${currentId}` && e.to === n.id) || (e.to === `app:${currentId}` && e.from === n.id)));
    return [...new Set(shared.map((n) => LINK_TEXT[n.type]))];
  };
  const reasons: Reason[] = [];
  const fraud = others.filter((o) => o.fraud);
  for (const f of fraud.slice(0, 3)) reasons.push({ code: "linked_to_fraud", severity: "red", text: `This application shares a ${viaFor(f.id).join(", ") || "detail"} with an application confirmed as fraud.` });
  const rest = others.length - fraud.length;
  if (rest >= 3) reasons.push({ code: "linked_many", severity: "amber", text: `This application is linked to ${rest} other applications through shared contact, bank or device details.` });
  else if (rest > 0) reasons.push({ code: "linked_some", severity: "info", text: `This application is linked to ${rest} other application(s) through shared details (a repeat client or a partner can explain this).` });
  return result(reasons, { linked_applications: others.length, linked_fraud: fraud.length });
}

export type StaffEvent = { kind: string; severity: string; created_at: string; user_label: string | null; detail?: Record<string, unknown> };

const EVENT_TEXT: Record<string, string> = {
  banking_details_changed: "changed the banking details on this file",
  approved_own_file: "moved a file they own to Accepted",
  bulk_export: "exported data in bulk",
  off_hours: "worked on this file at an unusual hour",
  high_volume: "opened an unusual number of files",
};

export function evaluateInsider(events: StaffEvent[]): CheckResult {
  if (!events.length) return result([{ code: "no_staff_events", severity: "info", text: "No unusual staff activity has been recorded on this file." }]);
  const reasons: Reason[] = events.slice(0, 6).map((e) => ({
    code: `staff_${e.kind}`,
    severity: e.severity === "red" ? "red" : e.severity === "info" ? "info" : "amber",
    text: `${e.user_label ?? "A staff member"} ${EVENT_TEXT[e.kind] ?? e.kind.replace(/_/g, " ")} on ${e.created_at.slice(0, 16).replace("T", " ")}.`,
  }));
  return result(reasons, { staff_events: events.length });
}

export type VoiceOutcome = { recordingId: string; status: "not_configured" | "error" | "likely_human" | "uncertain" | "likely_synthetic"; probability?: number };

export function evaluateVoice(outcomes: VoiceOutcome[], configured: boolean): CheckResult {
  if (!outcomes.length) return notApplicable("No recorded calls with this applicant were found.");
  if (!configured) return notConfigured(`${outcomes.length} recorded call(s) are ready to check, but no voice-analysis service is set up yet.`, "voice");
  const reasons: Reason[] = [];
  const synthetic = outcomes.filter((o) => o.status === "likely_synthetic");
  const unsure = outcomes.filter((o) => o.status === "uncertain");
  if (synthetic.length) reasons.push({ code: "voice_synthetic", severity: "red", text: `${synthetic.length} recorded call(s) sound machine-generated or cloned, according to the voice-analysis service.` });
  if (unsure.length) reasons.push({ code: "voice_uncertain", severity: "amber", text: `${unsure.length} recorded call(s) could not be confirmed as a live human voice.` });
  const errors = outcomes.filter((o) => o.status === "error").length;
  if (!reasons.length && errors === outcomes.length) return { status: "error", reasons: [{ code: "voice_error", severity: "info", text: "The voice-analysis service could not process the recordings." }] };
  if (!reasons.length) reasons.push({ code: "voice_ok", severity: "info", text: `${outcomes.length - errors} recorded call(s) sound like a live human voice.` });
  return result(reasons, { recordings: outcomes.length });
}
