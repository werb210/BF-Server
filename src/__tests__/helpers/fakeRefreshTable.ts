// BF_SERVER_v868_SLIDING_REFRESH - an in-memory staff_refresh_tokens table for tests. It answers by WHAT the SQL
// asks (BF_SERVER_SQL_CONTENT_MOCKS_v762), so the code under test may add or reorder queries freely; anything it does
// not recognise falls through to `fallback`.
type Row = {
  id: string; family_id: string; user_id: string; ksid: string | null; token_version: number; token_hash: string;
  session_started_at: Date; expires_at: Date; used_at: Date | null; revoked_at: Date | null; created_at: Date;
};

export function fakeRefreshTable(fallback: (sql: string, params?: unknown[]) => any = async () => ({ rows: [], rowCount: 0 })) {
  const rows: Row[] = [];
  const query = async (sql: unknown, params: unknown[] = []): Promise<any> => {
    const text = String(sql);
    if (!/staff_refresh_tokens/.test(text)) return fallback(text, params);
    const p = params as any[];
    if (/^\s*INSERT INTO staff_refresh_tokens/.test(text)) {
      rows.push({
        id: p[0], family_id: p[1], user_id: p[2], ksid: p[3], token_version: p[4], token_hash: p[5], session_started_at: new Date(p[6]),
        expires_at: new Date(p[7]), used_at: null, revoked_at: null, created_at: new Date(p[8]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (/SET used_at = \$2/.test(text)) {
      const at = new Date(p[1]);
      const r = rows.find((x) => x.token_hash === p[0] && !x.used_at && !x.revoked_at && x.expires_at > at);
      if (!r) return { rows: [], rowCount: 0 };
      r.used_at = at;
      return { rows: [{ family_id: r.family_id, user_id: r.user_id, ksid: r.ksid, token_version: r.token_version, session_started_at: r.session_started_at }], rowCount: 1 };
    }
    if (/^\s*SELECT/.test(text) && /WHERE token_hash = \$1/.test(text)) {
      const r = rows.find((x) => x.token_hash === p[0]);
      return { rows: r ? [{ family_id: r.family_id, used_at: r.used_at, revoked_at: r.revoked_at, expires_at: r.expires_at }] : [], rowCount: r ? 1 : 0 };
    }
    if (/SET revoked_at/.test(text)) {
      const by = /WHERE family_id/.test(text) ? "family_id" : "user_id";
      let n = 0;
      for (const r of rows) if (r[by] === p[0] && !r.revoked_at) { r.revoked_at = new Date(p[1]); n++; }
      return { rows: [], rowCount: n };
    }
    if (/^\s*DELETE FROM staff_refresh_tokens/.test(text)) {
      const before = new Date(p[0]);
      const keep = rows.filter((r) => !(r.expires_at < before));
      const n = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { rows: [], rowCount: n };
    }
    throw new Error("fakeRefreshTable: unexpected SQL " + text);
  };
  return { rows, query };
}
