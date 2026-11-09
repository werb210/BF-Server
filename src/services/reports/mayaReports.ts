// BF_SERVER_v930_MAYA_REPORTS - "Ask Maya for a report" on the Dashboard and Reports (HubSpot parity: AI-built report
// cards saved to a dashboard, and live tables). A question becomes either
//   - an existing report from the catalog (with a period), or
//   - a Maya table: a whitelisted count or total of applications or contacts grouped by one field, over an optional
//     period, in the person's silo. The spec is checked here and the SQL is built only from fixed pieces, so nothing
//     the model says reaches the database as SQL. Tables are live: the card re-reads them every time it is shown.
import { pool } from "../../db.js";
import { catalogFor } from "./catalog.js";

export type TableSpec = {
  title: string;
  object: "applications" | "contacts";
  group_by: string;
  measure: "count" | "total_amount";
  days: number | null;
};

const GROUPS: Record<TableSpec["object"], Record<string, { label: string; expr: string; join?: string }>> = {
  applications: {
    stage: { label: "Stage", expr: "coalesce(nullif(x.pipeline_state, ''), 'Not set')" },
    product: { label: "Product", expr: "coalesce(nullif(x.product_category, ''), 'Not set')" },
    source: { label: "Source", expr: "coalesce(nullif(x.source, ''), 'Not set')" },
    owner: { label: "Owner", expr: "coalesce(nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), 'Unassigned')", join: "LEFT JOIN users u ON u.id = x.owner_user_id" },
    month: { label: "Month", expr: "to_char(date_trunc('month', x.created_at), 'YYYY-MM')" },
  },
  contacts: {
    lead_status: { label: "Lead status", expr: "coalesce(nullif(x.lead_status, ''), 'Not set')" },
    stage: { label: "Stage", expr: "coalesce(nullif(x.lifecycle_stage, ''), 'Not set')" },
    owner: { label: "Owner", expr: "coalesce(nullif(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), 'Unassigned')", join: "LEFT JOIN users u ON u.id = x.owner_id" },
    month: { label: "Month", expr: "to_char(date_trunc('month', x.created_at), 'YYYY-MM')" },
    tag: { label: "Tag", expr: "t.tag", join: "CROSS JOIN LATERAL unnest(coalesce(x.tags, '{}')) AS t(tag)" },
  },
};

export function cleanSpec(raw: unknown): TableSpec | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const object = r.object === "contacts" ? "contacts" : r.object === "applications" ? "applications" : null;
  if (!object) return null;
  const group_by = String(r.group_by ?? "");
  if (!GROUPS[object][group_by]) return null;
  const measure = r.measure === "total_amount" && object === "applications" ? "total_amount" : "count";
  const d = Number(r.days);
  const days = Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 3650) : null;
  const title = String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
    || `${object === "applications" ? "Applications" : "Contacts"} by ${GROUPS[object][group_by]!.label.toLowerCase()}`;
  return { title, object, group_by, measure, days };
}

export async function runTable(spec: TableSpec, silo: string, db: { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> } = pool as any) {
  const g = GROUPS[spec.object][spec.group_by]!;
  const table = spec.object === "applications" ? "applications" : "contacts";
  const value = spec.measure === "total_amount" ? "coalesce(sum(x.requested_amount), 0)::float8" : "count(*)::int";
  const where = [`x.silo = $1`, ...(spec.days ? [`x.created_at >= now() - ($2::int * interval '1 day')`] : []),
    ...(table === "contacts" ? ["x.merged_into_id IS NULL", "coalesce(x.status, 'active') <> 'archived'"] : [])];
  const params: unknown[] = [silo, ...(spec.days ? [spec.days] : [])];
  const r = await db.query(
    `SELECT ${g.expr} AS label, ${value} AS value FROM ${table} x ${g.join ?? ""}
      WHERE ${where.join(" AND ")} GROUP BY 1 ORDER BY ${spec.group_by === "month" ? "1 DESC" : "2 DESC"} LIMIT 50`,
    params,
  );
  return {
    title: spec.title,
    columns: [GROUPS[spec.object][spec.group_by]!.label, spec.measure === "total_amount" ? "Total requested" : spec.object === "applications" ? "Applications" : "Contacts"],
    rows: r.rows.map((x: any) => ({ label: String(x.label), value: Number(x.value) })),
    measure: spec.measure,
    refreshed_at: new Date().toISOString(),
  };
}

export type AskResult =
  | { kind: "catalog"; report: string; title: string; days: number | null }
  | { kind: "table"; spec: TableSpec }
  | { kind: "none"; message: string };

type Create = (body: Record<string, unknown>) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;

/** Without the AI service: the catalog report whose title shares the most words with the question. */
export function keywordPick(question: string, catalog: Array<{ key: string; title: string; description: string }>): string | null {
  const words = new Set(question.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  let best: { key: string; score: number } | null = null;
  for (const r of catalog) {
    const hay = `${r.title} ${r.description}`.toLowerCase();
    const score = [...words].filter((w) => hay.includes(w)).length;
    if (score > 0 && (!best || score > best.score)) best = { key: r.key, score };
  }
  return best?.key ?? null;
}

export async function askReport(question: string, role: unknown, silo: string, create?: Create): Promise<AskResult> {
  const q = String(question ?? "").trim().slice(0, 500);
  if (!q) return { kind: "none", message: "Ask for a report, for example: applications by product this quarter." };
  const catalog = catalogFor(role).filter((r) => r.silo === silo && r.source !== "maya").map((r) => ({ key: r.key, title: r.title, description: r.description }));
  if (!process.env.OPENAI_API_KEY && !create) {
    const key = keywordPick(q, catalog);
    const hit = catalog.find((r) => r.key === key);
    return hit ? { kind: "catalog", report: hit.key, title: hit.title, days: null } : { kind: "none", message: "Maya could not match that to a report." };
  }
  let call = create;
  if (!call) {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    call = (body) => client.chat.completions.create(body as any) as any;
  }
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([o, g]) => [o, Object.keys(g)]));
  let parsed: any = null;
  try {
    const r = await call!({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: [
          "You turn a staff member's request into one dashboard report card. Answer with JSON only.",
          'If an existing report fits, answer {"kind":"catalog","report":"<key>","days":<number or null>}.',
          'Otherwise build a table: {"kind":"table","title":"<short title>","object":"applications"|"contacts","group_by":"<field>","measure":"count"|"total_amount","days":<number or null>}.',
          `Fields: ${JSON.stringify(groups)}. total_amount is only for applications (the amount requested).`,
          'days is the period in days ("this month" 30, "this quarter" 90, "this year" 365), null for all time.',
          'If nothing fits, answer {"kind":"none"}.',
          `Existing reports: ${JSON.stringify(catalog)}`,
        ].join("\n") },
        { role: "user", content: q },
      ],
    });
    parsed = JSON.parse(String(r.choices?.[0]?.message?.content ?? "{}"));
  } catch (err) {
    console.error("[maya-reports] ask failed", { message: err instanceof Error ? err.message : String(err) });
    const key = keywordPick(q, catalog);
    const hit = catalog.find((x) => x.key === key);
    return hit ? { kind: "catalog", report: hit.key, title: hit.title, days: null } : { kind: "none", message: "Maya could not be reached. Try again in a moment." };
  }
  if (parsed?.kind === "catalog") {
    const hit = catalog.find((x) => x.key === String(parsed.report ?? ""));
    const d = Number(parsed.days);
    if (hit) return { kind: "catalog", report: hit.key, title: hit.title, days: Number.isFinite(d) && d > 0 ? Math.min(Math.round(d), 365) : null };
  }
  if (parsed?.kind === "table") {
    const spec = cleanSpec(parsed);
    if (spec) return { kind: "table", spec };
  }
  return { kind: "none", message: "Maya could not build that report. Try naming what to count and how to group it." };
}
