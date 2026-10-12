// BF_SERVER_v789_CONVERSATION_TOKENS
// The website visitor's side of a "Talk to a human" thread used to be keyed by
// the conversation UUID alone, and /api/maya/escalate handed the contact's
// EXISTING conversation id to anyone who typed that contact's name and phone.
// Each escalate now mints a fresh random visitor token; only its sha256 is
// stored. The public read/post endpoints require it (X-Conversation-Token),
// and a token only reads messages created at or after it was issued, so a
// fresh token never reveals earlier history.
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db.js";

export const CONVERSATION_TOKEN_TTL_DAYS = 30;
export const CONVERSATION_TOKEN_HEADER = "x-conversation-token";

export function hashConversationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function issueConversationToken(conversationId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO public_conversation_tokens (id, conversation_id, token_hash, created_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now() + ($3::int * interval '1 day'))`,
    [conversationId, hashConversationToken(token), CONVERSATION_TOKEN_TTL_DAYS],
  );
  return token;
}

// The token's issue time when it is valid for this conversation, else null.
export async function verifyConversationToken(conversationId: string, token: string): Promise<{ createdAt: string } | null> {
  const t = String(token ?? "").trim();
  if (!t || t.length > 200) return null;
  const r = await pool.query<{ created_at: string }>(
    `SELECT created_at::text AS created_at
       FROM public_conversation_tokens
      WHERE conversation_id = $1 AND token_hash = $2 AND expires_at > now()
      ORDER BY created_at ASC
      LIMIT 1`,
    [conversationId, hashConversationToken(t)],
  );
  const row = r.rows[0];
  return row ? { createdAt: String(row.created_at) } : null;
}
