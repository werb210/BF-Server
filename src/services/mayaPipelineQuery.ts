// BF_SERVER_BLOCK_v214_MAYA_STAFF_PIPELINE_QUERY_v1
// Allowlist of canned pipeline queries that staff Maya can run.
// The model passes a natural-language question; we pattern-match
// against this table and execute the matched SQL with bound
// parameters. Any question that doesn't match returns a 200 with
// not_supported=true plus the list of supported intents so the
// model can tell the staff member what it CAN answer.
import { pool } from "../db.js";

type QueryDef = {
  key: string;
  label: string;
  // Lowercased keyword groups, ALL of which must appear in the
  // (lowercased) question to match. Cheap, deterministic, and easy
  // to audit. Order does not matter; partial-word matches OK.
  keywords: ReadonlyArray<ReadonlyArray<string>>;
  sql: string;
  describe: (rows: ReadonlyArray<Record<string, unknown>>) => string;
};

const QUERIES: ReadonlyArray<QueryDef> = [
  {
    key: "oldest_active_application",
    label: "Oldest active application",
    keywords: [["oldest"], ["application", "applications", "app", "apps", "deal", "deals"]],
    sql: `
      SELECT id, name, pipeline_state, created_at, submitted_at
        FROM applications
       WHERE COALESCE(pipeline_state, '') NOT IN ('Closed', 'Declined', 'Withdrawn', 'Funded')
       ORDER BY created_at ASC
       LIMIT 5
    `,
    describe: (rows) =>
      rows.length
        ? `Oldest active application: ${(rows[0] as any).name ?? (rows[0] as any).id} created ${(rows[0] as any).created_at}.`
        : "No active applications found.",
  },
  {
    key: "apps_missing_bank_statements",
    label: "Applications missing bank statements",
    keywords: [["missing", "without", "no"], ["bank", "statement", "statements"]],
    sql: `
      SELECT a.id, a.name, a.pipeline_state, a.created_at
        FROM applications a
       WHERE COALESCE(a.pipeline_state, '') NOT IN ('Closed', 'Declined', 'Withdrawn', 'Funded')
         AND NOT EXISTS (
           SELECT 1 FROM documents d
            WHERE d.application_id::text = a.id::text
              AND lower(COALESCE(d.document_type, '')) LIKE '%bank%'
         )
       ORDER BY a.created_at DESC
       LIMIT 25
    `,
    describe: (rows) =>
      `${rows.length} application(s) without a bank statement on file.`,
  },
  {
    key: "approvals_this_week",
    label: "Approvals this week",
    keywords: [["approval", "approvals", "approved"], ["week", "weekly", "this"]],
    sql: `
      SELECT id, name, pipeline_state, updated_at
        FROM applications
       WHERE pipeline_state ILIKE '%approv%'
         AND updated_at >= date_trunc('week', NOW())
       ORDER BY updated_at DESC
       LIMIT 50
    `,
    describe: (rows) => `${rows.length} approval(s) this week.`,
  },
  {
    key: "submissions_today",
    label: "Submissions today",
    keywords: [["submission", "submissions", "submitted"], ["today"]],
    sql: `
      SELECT id, name, pipeline_state, submitted_at
        FROM applications
       WHERE submitted_at >= date_trunc('day', NOW())
       ORDER BY submitted_at DESC
       LIMIT 50
    `,
    describe: (rows) => `${rows.length} application(s) submitted today.`,
  },
  {
    key: "submissions_this_week",
    label: "Submissions this week",
    keywords: [["submission", "submissions", "submitted"], ["week"]],
    sql: `
      SELECT id, name, pipeline_state, submitted_at
        FROM applications
       WHERE submitted_at >= date_trunc('week', NOW())
       ORDER BY submitted_at DESC
       LIMIT 100
    `,
    describe: (rows) => `${rows.length} application(s) submitted this week.`,
  },
  {
    key: "demo_applications",
    label: "Demo applications",
    keywords: [["demo", "test"], ["application", "applications", "app", "apps"]],
    sql: `
      SELECT id, name, pipeline_state, created_at
        FROM applications
       WHERE COALESCE(metadata->>'is_demo', 'false') = 'true'
       ORDER BY created_at DESC
       LIMIT 50
    `,
    describe: (rows) => `${rows.length} demo application(s) in the system.`,
  },
  {
    key: "contacts_touched_today",
    label: "Contacts touched today",
    keywords: [["contact", "contacts"], ["today", "touched", "active"]],
    sql: `
      SELECT id, full_name, company, updated_at
        FROM contacts
       WHERE updated_at >= date_trunc('day', NOW())
       ORDER BY updated_at DESC
       LIMIT 50
    `,
    describe: (rows) => `${rows.length} contact(s) updated today.`,
  },
  {
    key: "applications_in_review",
    label: "Applications in review",
    keywords: [["review", "reviewing"], ["application", "applications", "app", "apps", "stage", "deals"]],
    sql: `
      SELECT id, name, pipeline_state, updated_at
        FROM applications
       WHERE pipeline_state ILIKE '%review%'
       ORDER BY updated_at DESC
       LIMIT 50
    `,
    describe: (rows) => `${rows.length} application(s) currently in review.`,
  },
  {
    key: "count_applications",
    label: "Total application count",
    keywords: [["how many", "count", "total", "number of"], ["application", "applications", "app", "apps", "deal", "deals"]],
    sql: `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE COALESCE(pipeline_state, '') NOT IN ('Closed','Declined','Withdrawn','Funded'))::int AS active
        FROM applications
    `,
    describe: (rows) => {
      const r = (rows[0] ?? {}) as Record<string, unknown>;
      return `${r.total ?? 0} application(s) total, ${r.active ?? 0} active.`;
    },
  },
  {
    key: "count_contacts",
    label: "Total contact count",
    keywords: [["how many", "count", "total", "number of"], ["contact", "contacts", "crm", "lead", "leads", "people"]],
    sql: `SELECT COUNT(*)::int AS total FROM contacts`,
    describe: (rows) => `${(rows[0] as Record<string, unknown> | undefined)?.total ?? 0} contact(s) in the CRM.`,
  },
  {
    key: "applications_by_stage",
    label: "Applications by stage",
    keywords: [["by stage", "per stage", "each stage", "breakdown", "by status"], ["application", "applications", "app", "apps", "pipeline", "deal", "deals"]],
    sql: `
      SELECT COALESCE(pipeline_state, '(none)') AS stage, COUNT(*)::int AS n
        FROM applications
       WHERE COALESCE(pipeline_state, '') NOT IN ('Closed','Declined','Withdrawn','Funded')
       GROUP BY 1
       ORDER BY 2 DESC
    `,
    describe: (rows) =>
      rows.length
        ? "Active pipeline by stage: " + rows.map((r) => `${(r as Record<string, unknown>).stage}: ${(r as Record<string, unknown>).n}`).join(", ") + "."
        : "No active applications.",
  },
];

type MatchResult =
  | { matched: true; query: QueryDef }
  | { matched: false; supported: ReadonlyArray<{ key: string; label: string }> };

function matchQuery(question: string): MatchResult {
  const q = question.toLowerCase();
  let best: { def: QueryDef; score: number } | null = null;
  for (const def of QUERIES) {
    const allGroupsHit = def.keywords.every((group) =>
      group.some((kw) => q.includes(kw)),
    );
    if (!allGroupsHit) continue;
    // Score = total individual keyword hits (so more specific
    // questions beat broader ones).
    const score = def.keywords.reduce(
      (acc, group) => acc + group.filter((kw) => q.includes(kw)).length,
      0,
    );
    if (!best || score > best.score) best = { def, score };
  }
  if (best) return { matched: true, query: best.def };
  return {
    matched: false,
    supported: QUERIES.map((q) => ({ key: q.key, label: q.label })),
  };
}

export type RunResult = {
  ok: boolean;
  query?: string;
  label?: string;
  rows?: ReadonlyArray<Record<string, unknown>>;
  summary?: string;
  not_supported?: boolean;
  supported_queries?: ReadonlyArray<{ key: string; label: string }>;
};

export async function runPipelineQuery(question: string): Promise<RunResult> {
  const m = matchQuery(question);
  if (!m.matched) {
    return {
      ok: true,
      not_supported: true,
      summary: "I can't answer that question yet. Here's what I can run.",
      supported_queries: m.supported,
    };
  }
  const r = await pool.query(m.query.sql);
  const rows = (r.rows ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    query: m.query.key,
    label: m.query.label,
    rows,
    summary: m.query.describe(rows),
  };
}

// Test-only export for unit coverage.
export const __test = { matchQuery, QUERIES };
