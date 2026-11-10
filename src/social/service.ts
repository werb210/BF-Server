// BF_SERVER_v937_SOCIAL_POSTING - storage and publishing for social accounts and posts.
import { open, seal } from "./crypto.js";
import { defaultHttp, publish, refreshIfNeeded, type Http, type Live, type Network, type NewAccount } from "./networks.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type AccountRow = { id: string; network: Network; name: string; status: string; last_error: string | null; expires_at: string | null; created_at: string };
export type PostRow = { id: string; body: string; link_url: string | null; image_url: string | null; account_ids: string[]; scheduled_at: string | null; status: string; results: Record<string, any>; created_at: string; published_at: string | null };

const ACCOUNT_COLS = "id::text AS id, network, name, status, last_error, expires_at, created_at";
const POST_COLS = "id::text AS id, body, link_url, image_url, account_ids::text[] AS account_ids, scheduled_at, status, results, created_at, published_at";

export async function listAccounts(q: Q, silo: string): Promise<AccountRow[]> {
  return (await q.query(`SELECT ${ACCOUNT_COLS} FROM social_accounts WHERE silo = $1 ORDER BY network, name`, [silo])).rows;
}

export async function saveAccounts(q: Q, silo: string, accounts: NewAccount[], userId: string | null): Promise<number> {
  for (const a of accounts) {
    await q.query(
      `INSERT INTO social_accounts (silo, network, external_id, name, access_token_enc, refresh_token_enc, expires_at, meta, connected_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (silo, network, external_id) DO UPDATE SET name = EXCLUDED.name, access_token_enc = EXCLUDED.access_token_enc,
         refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, social_accounts.refresh_token_enc), expires_at = EXCLUDED.expires_at,
         meta = EXCLUDED.meta, status = 'connected', last_error = NULL, connected_by = EXCLUDED.connected_by, updated_at = now()`,
      [silo, a.network, a.external_id, a.name, seal(a.access_token), seal(a.refresh_token ?? null), a.expires_at ?? null, JSON.stringify(a.meta ?? {}), userId],
    );
  }
  return accounts.length;
}

export async function removeAccount(q: Q, silo: string, id: string): Promise<boolean> {
  return ((await q.query(`DELETE FROM social_accounts WHERE id::text = $1 AND silo = $2 RETURNING id`, [id, silo])).rows.length) > 0;
}

export async function listPosts(q: Q, silo: string, limit = 100): Promise<PostRow[]> {
  return (await q.query(`SELECT ${POST_COLS} FROM social_posts WHERE silo = $1 ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT $2`, [silo, limit])).rows;
}

export async function createPost(q: Q, silo: string, p: { body: string; link_url: string | null; image_url: string | null; account_ids: string[]; scheduled_at: Date | null }, userId: string | null): Promise<PostRow> {
  const owned = (await q.query(`SELECT id::text AS id FROM social_accounts WHERE silo = $1 AND id::text = ANY($2::text[])`, [silo, p.account_ids])).rows.map((r) => r.id);
  if (!owned.length) throw Object.assign(new Error("Choose at least one connected account."), { status: 400 });
  return (await q.query(
    `INSERT INTO social_posts (silo, body, link_url, image_url, account_ids, scheduled_at, status, created_by)
     VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7,$8) RETURNING ${POST_COLS}`,
    [silo, p.body, p.link_url, p.image_url, owned, p.scheduled_at, p.scheduled_at ? "scheduled" : "publishing", userId],
  )).rows[0];
}

export async function cancelPost(q: Q, silo: string, id: string): Promise<boolean> {
  return ((await q.query(`UPDATE social_posts SET status = 'cancelled' WHERE id::text = $1 AND silo = $2 AND status = 'scheduled' RETURNING id`, [id, silo])).rows.length) > 0;
}

/** Publishes one post to each of its accounts; one account failing never stops the others. */
export async function publishPost(q: Q, postId: string, http: Http = defaultHttp): Promise<PostRow> {
  const post = (await q.query(`SELECT ${POST_COLS}, silo FROM social_posts WHERE id::text = $1`, [postId])).rows[0];
  if (!post) throw new Error("post not found");
  const accounts = (await q.query(
    `SELECT id::text AS id, network, name, external_id, access_token_enc, refresh_token_enc, expires_at, meta FROM social_accounts WHERE silo = $1 AND id::text = ANY($2::text[])`,
    [post.silo, post.account_ids],
  )).rows;
  const results: Record<string, any> = {};
  for (const accId of post.account_ids as string[]) {
    const a = accounts.find((x) => x.id === accId);
    if (!a) { results[accId] = { ok: false, error: "That account was disconnected." }; continue; }
    try {
      const live: Live = { network: a.network, external_id: a.external_id, access_token: open(a.access_token_enc) ?? "", refresh_token: open(a.refresh_token_enc), expires_at: a.expires_at ? new Date(a.expires_at) : null, meta: a.meta ?? {} };
      const fresh = await refreshIfNeeded(live, http);
      if (fresh) {
        live.access_token = fresh.access_token;
        await q.query(`UPDATE social_accounts SET access_token_enc = $2, refresh_token_enc = COALESCE($3, refresh_token_enc), expires_at = $4, updated_at = now() WHERE id::text = $1`,
          [a.id, seal(fresh.access_token), seal(fresh.refresh_token ?? null), fresh.expires_at ?? null]);
      }
      const r = await publish(live, { text: post.body, link: post.link_url, image: post.image_url }, http);
      results[accId] = { ok: true, network: a.network, name: a.name, external_id: r.external_id, url: r.url };
      await q.query(`UPDATE social_accounts SET status = 'connected', last_error = NULL WHERE id::text = $1`, [a.id]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results[accId] = { ok: false, network: a.network, name: a.name, error: message };
      const status = Number((err as any)?.status);
      if (status === 401 || /expired|connect .* again|invalid.*token/i.test(message)) {
        await q.query(`UPDATE social_accounts SET status = 'needs_reconnect', last_error = $2 WHERE id::text = $1`, [a.id, message.slice(0, 300)]);
      }
      console.warn("[social] publish failed", { postId, network: a.network, message });
    }
  }
  const oks = Object.values(results).filter((r: any) => r.ok).length;
  const status = oks === post.account_ids.length ? "published" : oks ? "partial" : "failed";
  return (await q.query(`UPDATE social_posts SET status = $2, results = $3::jsonb, published_at = now() WHERE id::text = $1 RETURNING ${POST_COLS}`, [postId, status, JSON.stringify(results)])).rows[0];
}

/** Claims the scheduled posts that are due (one worker at a time) and publishes them. */
export async function publishDue(q: Q, http: Http = defaultHttp): Promise<number> {
  const due = (await q.query(
    `UPDATE social_posts SET status = 'publishing' WHERE id IN (
       SELECT id FROM social_posts WHERE status = 'scheduled' AND scheduled_at <= now() ORDER BY scheduled_at LIMIT 10 FOR UPDATE SKIP LOCKED)
     RETURNING id::text AS id`,
  )).rows;
  for (const d of due) await publishPost(q, d.id, http);
  return due.length;
}
