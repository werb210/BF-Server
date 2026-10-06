// BF_SERVER_SQL_CONTENT_MOCKS_v762
// Database mocks in tests must answer by WHAT is asked, not by the ORDER queries happen to run in. A chain of
// mockResolvedValueOnce answers breaks silently when the code under test adds, removes or reorders a query: the
// wrong row reaches the wrong query and the test either fails for no real reason or, worse, still passes.
//
//   queryMock.mockImplementation(answerBySql([
//     [/FROM broker_imports/, { rows: [open] }],
//     [/SELECT id FROM applications/, { rows: [] }],
//   ]));
//
// The first rule whose pattern matches the SQL text answers; a function answer receives (sql, params). Anything
// unmatched gets the fallback (empty rows by default), so an unexpected extra query cannot steal a planned answer.
export type SqlAnswer = unknown | ((sql: string, params?: unknown[]) => unknown);
export type SqlRule = [RegExp | string, SqlAnswer];

export function sqlText(sql: unknown): string {
  if (typeof sql === "string") return sql;
  if (sql && typeof sql === "object" && "text" in (sql as Record<string, unknown>)) return String((sql as { text: unknown }).text);
  return String(sql ?? "");
}

export function answerBySql(rules: SqlRule[], fallback: unknown = { rows: [], rowCount: 0 }) {
  return async (sql: unknown, params?: unknown[]): Promise<any> => {
    const text = sqlText(sql);
    for (const [match, answer] of rules) {
      const hit = typeof match === "string" ? text.includes(match) : match.test(text);
      if (!hit) continue;
      const out = typeof answer === "function" ? (answer as (s: string, p?: unknown[]) => unknown)(text, params) : answer;
      if (out instanceof Error) throw out;
      return out;
    }
    return fallback;
  };
}

/** The calls whose SQL matches, e.g. to assert on an UPDATE's parameters without knowing its position. */
export function callsMatching(mock: { mock: { calls: unknown[][] } }, match: RegExp | string): unknown[][] {
  return mock.mock.calls.filter((c) => (typeof match === "string" ? sqlText(c[0]).includes(match) : match.test(sqlText(c[0]))));
}
