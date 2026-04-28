// BF_MINI_PORTAL_NOTES_v47 — parse @mentions from a note body and resolve to user ids.
import { runQuery } from "../../lib/db.js";

const MENTION_RE = /(^|[\s(])@([a-zA-Z0-9_.\-]{2,40})(?![a-zA-Z0-9_.\-])/g;

export function extractMentionTokens(body: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(body)) !== null) out.add(m[2].toLowerCase());
  return [...out];
}

export async function resolveMentionUserIds(tokens: string[]): Promise<string[]> {
  if (!tokens.length) return [];
  const r = await runQuery<{ id: string }>(
    `SELECT id FROM users
      WHERE LOWER(COALESCE(username, email, first_name || '.' || last_name)) = ANY($1::text[])
         OR LOWER(SPLIT_PART(email, '@', 1)) = ANY($1::text[])`,
    [tokens]
  ).catch(() => ({ rows: [] as { id: string }[] }));
  return r.rows.map((row) => row.id);
}

export async function parseAndResolveMentions(body: string): Promise<string[]> {
  const tokens = extractMentionTokens(body);
  if (!tokens.length) return [];
  return resolveMentionUserIds(tokens);
}
