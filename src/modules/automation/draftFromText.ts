// BF_SERVER_v786_WORKFLOW_GRAPH - POST /api/automations/draft-from-text. OpenAI (gpt-4o) turns a
// description into {name, graph, settings, goal}. The catalog is in the prompt so the model can only
// use triggers, actions, fields, templates, lists and workflows that exist; the route then validates
// the result strictly and refuses anything with issues.
import { DEFAULT_TZ, normalizeSettings, type Goal, type Graph, type Settings } from "./graph.js";

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
Use only the triggers, actions, fields, operators, template ids, list ids and workflow ids in the catalog. Use personalization tokens like {{first_name}}, {{owner_name}}, {{application_link}} in text.`;

type Completion = { choices?: Array<{ message?: { content?: string | null } }> };

export async function draftWorkflowFromText(prompt: string, catalog: Record<string, unknown>, create?: (body: Record<string, unknown>) => Promise<Completion>): Promise<Draft | { error: string }> {
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
    nodes: g.nodes && typeof g.nodes === "object" && !Array.isArray(g.nodes) ? g.nodes : {},
  };
  return {
    name: String(parsed.name ?? "Drafted workflow").slice(0, 120),
    graph,
    settings: normalizeSettings(parsed.settings),
    goal: parsed.goal && typeof parsed.goal === "object" ? parsed.goal : null,
  };
}
