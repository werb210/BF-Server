// BF_SERVER_v786_WORKFLOW_GRAPH - POST /api/automations/draft-from-text. OpenAI (gpt-4o) turns a
// description into {name, graph, settings, goal}. The catalog is in the prompt so the model can only
// use triggers, actions, fields, templates, lists and workflows that exist; the route then validates
// the result strictly and refuses anything with issues.
import { ACTION_TYPES, DEFAULT_TZ, normalizeSettings, type Goal, type Graph, type Settings } from "./graph.js";

export type Draft = { name: string; graph: Graph; settings: Settings; goal: Goal };

const FORMAT = `Return ONLY a JSON object: {"name": string, "graph": Graph, "settings": Settings, "goal": Goal|null}.
Graph = {"triggers": [{"type", "filters": [{"field","op","value"}], "filterLogic": "all"|"any", "params"?: {}}], "startNodeId": string, "nodes": {"<id>": Node}}
Node kinds (every node's "id" equals its key; next/noneNext/timeoutNext null = end):
 {"id","kind":"action","action","params","next"}
 {"id","kind":"delay","mode":"duration","params":{"amount","unit":"minutes"|"hours"|"days"},"next"}
 {"id","kind":"delay","mode":"until_time","params":{"time":"HH:MM","weekdays":[0-6]|null,"tz":"${DEFAULT_TZ}"},"next"}
 {"id","kind":"delay","mode":"until_event","params":{"event","timeoutAmount","timeoutUnit"},"next","timeoutNext"}
 {"id","kind":"branch","branches":[{"id","label","logic":"all"|"any","conditions":[{"field","op","value"}],"next"}],"noneNext"}
 {"id","kind":"value_branch","field","cases":[{"id","label","value","next"}],"noneNext"}
 {"id","kind":"goto","target"}
Settings = {"reenroll":"never"|"after_complete"|"always","quietHours":{"enabled":true,"start":"09:00","end":"20:00","tz":"${DEFAULT_TZ}"},"unenrollOnGoal":true,"testMode":false}
Goal = null | {"logic":"all"|"any","conditions":[{"field","op","value"}]}
date.relative triggers put {"field","offsetDays","time"} in params; no_reply triggers put {"days"} in params.
Use only the triggers, actions, fields, operators, template ids, list ids and workflow ids in the catalog. Use personalization tokens like {{first_name}}, {{owner_name}}, {{application_link}} in text.
"kind" is always exactly one of: action, delay, branch, value_branch, goto. An action step puts the action name in "action", never in "kind". Example: {"id":"s1","kind":"action","action":"send_sms","params":{"body":"Hi {{first_name}}, your offer is ready.","kind":"transactional"},"next":"s2"}.
Build every step the description asks for, in the order it asks, linked through "next".
For send_sms and notify_client write the text the description asks for in params.body; use a catalog templateId only when that template says the same thing.
People: to reach the contact's owner put "owner" in params.to (notify_staff) or params.assignee (create_task). A specific person is that person's id from catalog.users. assign_owner needs params.userId from catalog.users. Never write {{owner_id}} or a person's name in these fields.
"From the website" means the trigger filter {"field":"source","op":"in","value":["website","website_form","readiness_check"]}.`;

type Completion = { choices?: Array<{ message?: { content?: string | null } }> };

// BF_SERVER_v795_DRAFT_REPAIR - models sometimes put the action name in "kind" ({"kind":"send_sms"}).
// That step is then unknown, and every step after it is unreachable, so the editor showed one broken
// step. Such steps are rewritten to {"kind":"action","action":...} before validation.
const NODE_KINDS = new Set(["action", "delay", "branch", "value_branch", "goto"]);
export function normalizeDraftNodes(nodes: Record<string, any>, users: Array<{ id: string; name: string }> = []): Record<string, any> {
  // BF_SERVER_v796_PEOPLE_CHECK - {{owner_id}} / "owner_id" mean the contact owner; a staff name becomes its id.
  const person = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const s = v.trim();
    if (/^\{\{\s*(contact_)?owner(_id|name)?\s*\}\}$/i.test(s) || /^(contact)?owner(_id)?$/i.test(s)) return "owner";
    const hit = users.find((u) => String(u.name ?? "").trim().toLowerCase() === s.toLowerCase());
    return hit ? hit.id : s;
  };
  const out: Record<string, any> = {};
  for (const [key, raw] of Object.entries(nodes)) {
    if (!raw || typeof raw !== "object") { out[key] = raw; continue; }
    const n: Record<string, any> = { ...raw };
    if (typeof n.id !== "string" || !n.id) n.id = key;
    const kind = String(n.kind ?? "");
    if (!NODE_KINDS.has(kind)) {
      if ((ACTION_TYPES as readonly string[]).includes(kind)) { n.action = kind; n.kind = "action"; }
      else if (kind === "wait") { n.kind = "delay"; n.mode = "duration"; n.params = { amount: Number(n.params?.amount ?? n.amount ?? 1), unit: String(n.params?.unit ?? n.unit ?? "days") }; }
      else if (!kind && typeof n.action === "string") n.kind = "action";
    }
    if (n.kind === "action") {
      if (!n.action && typeof n.type === "string" && (ACTION_TYPES as readonly string[]).includes(n.type)) n.action = n.type;
      n.params = n.params && typeof n.params === "object" ? { ...n.params } : {};
      if (n.params.assignee !== undefined) n.params.assignee = person(n.params.assignee);
      if (n.action === "notify_staff" && n.params.to !== undefined) n.params.to = person(n.params.to);
      if (n.params.userId !== undefined) { const v = person(n.params.userId); n.params.userId = v === "owner" ? "" : v; }
      if (Array.isArray(n.params.userIds)) n.params.userIds = n.params.userIds.map(person).filter((x: unknown) => x !== "owner");
      if (n.next === undefined) n.next = null;
    }
    out[key] = n;
  }
  return out;
}

export type DraftRepair = { previous: string; issues: string[] };

export async function draftWorkflowFromText(prompt: string, catalog: Record<string, unknown>, create?: (body: Record<string, unknown>) => Promise<Completion>, repair?: DraftRepair): Promise<Draft | { error: string }> {
  let call = create;
  if (!call) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    call = (body) => client.chat.completions.create(body as any) as Promise<Completion>;
  }
  let content = "";
  try {
    const r = await call({
      model: "gpt-4o",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You design marketing and sales workflows for Boreal Financial's CRM.\n" + FORMAT + "\nCatalog:\n" + JSON.stringify(catalog) },
        { role: "user", content: prompt },
        ...(repair ? [
          { role: "assistant", content: repair.previous },
          { role: "user", content: "That draft has these problems:\n- " + repair.issues.join("\n- ") + "\nReturn the complete corrected JSON object, with every step the description asks for." },
        ] : []),
      ],
    });
    content = String(r.choices?.[0]?.message?.content ?? "");
  } catch (err: any) {
    console.error("[automation] draft-from-text OpenAI call failed", { message: err?.message ?? String(err) });
    return { error: "the drafting service could not be reached" };
  }
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return { error: "the draft was not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || !parsed.graph || typeof parsed.graph !== "object") return { error: "the draft has no graph" };
  const g = parsed.graph;
  const graph: Graph = {
    triggers: Array.isArray(g.triggers) ? g.triggers : [],
    startNodeId: typeof g.startNodeId === "string" ? g.startNodeId : null,
    nodes: g.nodes && typeof g.nodes === "object" && !Array.isArray(g.nodes) ? normalizeDraftNodes(g.nodes, Array.isArray((catalog as any).users) ? (catalog as any).users : []) : {},
  };
  return {
    name: String(parsed.name ?? "Drafted workflow").slice(0, 120),
    graph,
    settings: normalizeSettings(parsed.settings),
    goal: parsed.goal && typeof parsed.goal === "object" ? parsed.goal : null,
  };
}
