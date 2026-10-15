// BF_SERVER_v810_LIBRARY_PLUS - what the Staff Library keeps beside OneDrive: activity, stars, the 30-day recycle bin,
// share links for people outside Boreal and upload links (file requests). Tables: migrations/2026_10_15_staff_library_plus.sql.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { pool } from "../../db.js";

export const TRASH_FOLDER_NAME = "Recycle Bin (Boreal)";
export const TRASH_DAYS = 30;

export type LibraryRow = { drive_id: string | null; item_id: string; share_url: string; created_by: string | null; trash_item_id: string | null };

export async function getLibrary(): Promise<LibraryRow | null> {
  const r = await pool.query<LibraryRow>("SELECT drive_id, item_id, share_url, created_by, trash_item_id FROM staff_library WHERE id = 1");
  return r.rows[0] ?? null;
}

export async function setTrashFolder(itemId: string): Promise<void> {
  await pool.query("UPDATE staff_library SET trash_item_id = $1 WHERE id = 1", [itemId]);
}

// ---- activity --------------------------------------------------------------------------------------------------
export type ActivityAction =
  | "uploaded" | "created_folder" | "renamed" | "moved" | "deleted" | "restored" | "opened"
  | "shared_link" | "requested_files" | "received_upload" | "restored_version" | "sent_to_client" | "downloaded_zip";

export async function logActivity(a: { itemId: string; itemName: string; isFolder?: boolean; action: ActivityAction; actorId?: string | null; actorName?: string | null; detail?: string | null }): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO library_activity (item_id, item_name, is_folder, action, actor_id, actor_name, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [a.itemId, a.itemName.slice(0, 300), a.isFolder === true, a.action, a.actorId ?? null, a.actorName ?? null, a.detail ? a.detail.slice(0, 500) : null],
    );
  } catch (err) {
    console.warn("[staff-library] activity not recorded", { action: a.action, message: err instanceof Error ? err.message : String(err) });
  }
}

export async function listActivity(limit = 100): Promise<any[]> {
  const r = await pool.query(
    `SELECT id, item_id, item_name, is_folder, action, actor_name, detail, created_at FROM library_activity ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 300)],
  );
  return r.rows;
}

// The team's recent files: the latest thing that happened to each file (newest first), deleted items left out.
export async function listRecent(limit = 30): Promise<any[]> {
  const r = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (a.item_id) a.item_id, a.item_name, a.is_folder, a.action, a.actor_name, a.created_at
         FROM library_activity a
        WHERE a.is_folder = false AND a.action <> 'deleted'
          AND NOT EXISTS (SELECT 1 FROM library_trash t WHERE t.item_id = a.item_id)
        ORDER BY a.item_id, a.created_at DESC
     ) x ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(1, limit), 100)],
  );
  return r.rows;
}

// ---- stars -----------------------------------------------------------------------------------------------------
export async function listStars(userId: string): Promise<any[]> {
  const r = await pool.query(
    `SELECT s.item_id, s.item_name, s.is_folder, s.created_at FROM library_stars s
      WHERE s.user_id = $1 AND NOT EXISTS (SELECT 1 FROM library_trash t WHERE t.item_id = s.item_id)
      ORDER BY s.created_at DESC`,
    [userId],
  );
  return r.rows;
}
export async function setStar(userId: string, item: { id: string; name: string; isFolder: boolean }, starred: boolean): Promise<void> {
  if (starred) {
    await pool.query(
      `INSERT INTO library_stars (user_id, item_id, item_name, is_folder) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, item_id) DO UPDATE SET item_name = EXCLUDED.item_name`,
      [userId, item.id, item.name, item.isFolder],
    );
  } else {
    await pool.query(`DELETE FROM library_stars WHERE user_id = $1 AND item_id = $2`, [userId, item.id]);
  }
}
export async function renameEverywhere(itemId: string, name: string): Promise<void> {
  await pool.query(`UPDATE library_stars SET item_name = $2 WHERE item_id = $1`, [itemId, name]);
  await pool.query(`UPDATE library_share_links SET item_name = $2 WHERE item_id = $1`, [itemId, name]);
}

// ---- recycle bin -----------------------------------------------------------------------------------------------
export async function addTrash(t: { itemId: string; itemName: string; isFolder: boolean; originalParentId: string; originalPath: string | null; deletedBy: string; deletedByName: string | null }): Promise<void> {
  await pool.query(
    `INSERT INTO library_trash (item_id, item_name, is_folder, original_parent_id, original_path, deleted_by, deleted_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (item_id) DO UPDATE SET deleted_at = now(), original_parent_id = EXCLUDED.original_parent_id, deleted_by = EXCLUDED.deleted_by, deleted_by_name = EXCLUDED.deleted_by_name`,
    [t.itemId, t.itemName, t.isFolder, t.originalParentId, t.originalPath, t.deletedBy, t.deletedByName],
  );
}
export async function listTrash(): Promise<any[]> {
  const r = await pool.query(
    `SELECT item_id, item_name, is_folder, original_parent_id, original_path, deleted_by_name, deleted_at,
            (deleted_at + make_interval(days => ${TRASH_DAYS})) AS purge_at
       FROM library_trash ORDER BY deleted_at DESC`,
  );
  return r.rows;
}
export async function getTrash(itemId: string): Promise<any | null> {
  const r = await pool.query(`SELECT * FROM library_trash WHERE item_id = $1`, [itemId]);
  return r.rows[0] ?? null;
}
export async function removeTrash(itemId: string): Promise<void> {
  await pool.query(`DELETE FROM library_trash WHERE item_id = $1`, [itemId]);
}
export async function expiredTrash(): Promise<Array<{ item_id: string; item_name: string }>> {
  const r = await pool.query(`SELECT item_id, item_name FROM library_trash WHERE deleted_at < now() - make_interval(days => ${TRASH_DAYS}) LIMIT 50`);
  return r.rows;
}

// ---- tokens and passwords --------------------------------------------------------------------------------------
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token) };
}
export function hashToken(token: string): string {
  return createHash("sha256").update(String(token)).digest("hex");
}
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return "scrypt$" + salt.toString("hex") + "$" + scryptSync(password, salt, 32).toString("hex");
}
export function passwordMatches(password: string, stored: string | null): boolean {
  if (!stored) return true;
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, "hex");
  const got = scryptSync(String(password ?? ""), Buffer.from(saltHex, "hex"), want.length);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- share links -----------------------------------------------------------------------------------------------
export async function createShareLink(s: { itemId: string; itemName: string; allowDownload: boolean; password: string | null; expiresDays: number; createdBy: string; createdByName: string | null }): Promise<{ id: string; token: string; expiresAt: string }> {
  const t = newToken();
  const r = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO library_share_links (token_hash, item_id, item_name, allow_download, password_hash, expires_at, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6::int), $7, $8) RETURNING id, expires_at`,
    [t.hash, s.itemId, s.itemName, s.allowDownload, s.password ? hashPassword(s.password) : null, s.expiresDays, s.createdBy, s.createdByName],
  );
  return { id: r.rows[0]!.id, token: t.token, expiresAt: r.rows[0]!.expires_at };
}
export async function listShareLinks(): Promise<any[]> {
  const r = await pool.query(
    `SELECT id, item_id, item_name, allow_download, (password_hash IS NOT NULL) AS has_password, expires_at, created_by_name, created_at,
            revoked_at, open_count, last_opened_at
       FROM library_share_links
      WHERE revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 200`,
  );
  return r.rows;
}
export async function revokeShareLink(id: string): Promise<boolean> {
  const r = await pool.query(`UPDATE library_share_links SET revoked_at = now() WHERE id::text = $1 AND revoked_at IS NULL`, [id]);
  return Number(r.rowCount ?? 0) > 0;
}
export async function findShareLink(token: string): Promise<any | null> {
  const r = await pool.query(`SELECT * FROM library_share_links WHERE token_hash = $1`, [hashToken(token)]);
  return r.rows[0] ?? null;
}
export async function countShareOpen(id: string): Promise<void> {
  await pool.query(`UPDATE library_share_links SET open_count = open_count + 1, last_opened_at = now() WHERE id = $1`, [id]);
}

// ---- file requests ---------------------------------------------------------------------------------------------
export async function createFileRequest(f: { folderId: string; folderName: string; title: string; expiresDays: number; createdBy: string; createdByName: string | null }): Promise<{ id: string; token: string; expiresAt: string }> {
  const t = newToken();
  const r = await pool.query<{ id: string; expires_at: string }>(
    `INSERT INTO library_file_requests (token_hash, folder_id, folder_name, title, expires_at, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5::int), $6, $7) RETURNING id, expires_at`,
    [t.hash, f.folderId, f.folderName, f.title, f.expiresDays, f.createdBy, f.createdByName],
  );
  return { id: r.rows[0]!.id, token: t.token, expiresAt: r.rows[0]!.expires_at };
}
export async function listFileRequests(): Promise<any[]> {
  const r = await pool.query(
    `SELECT id, folder_id, folder_name, title, expires_at, created_by_name, created_at, upload_count, last_upload_at
       FROM library_file_requests WHERE closed_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 200`,
  );
  return r.rows;
}
export async function closeFileRequest(id: string): Promise<boolean> {
  const r = await pool.query(`UPDATE library_file_requests SET closed_at = now() WHERE id::text = $1 AND closed_at IS NULL`, [id]);
  return Number(r.rowCount ?? 0) > 0;
}
export async function findFileRequest(token: string): Promise<any | null> {
  const r = await pool.query(`SELECT * FROM library_file_requests WHERE token_hash = $1`, [hashToken(token)]);
  return r.rows[0] ?? null;
}
export async function countRequestUpload(id: string): Promise<void> {
  await pool.query(`UPDATE library_file_requests SET upload_count = upload_count + 1, last_upload_at = now() WHERE id = $1`, [id]);
}
export async function notifyStaff(userId: string, refId: string, title: string, body: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, ref_table, ref_id, context_url)
       VALUES ($1::uuid, 'library_upload', $2, $3, 'library_file_requests', $4, '/settings/library')
       ON CONFLICT ON CONSTRAINT notifications_unique_per_ref DO NOTHING`,
      [userId, title.slice(0, 200), body.slice(0, 500), refId],
    );
  } catch (err) {
    console.warn("[staff-library] notification not saved", { message: err instanceof Error ? err.message : String(err) });
  }
}

// ---- "Send to client": find a BF contact, with their newest application -----------------------------------------
export async function searchClients(q: string): Promise<Array<{ id: string; name: string; email: string | null; phone: string | null; application_id: string | null }>> {
  const term = q.trim().slice(0, 80);
  const digits = term.replace(/[^0-9]/g, "");
  const r = await pool.query(
    `SELECT c.id::text AS id, COALESCE(NULLIF(c.name, ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS name,
            c.email, c.phone,
            (SELECT a.id::text FROM applications a WHERE a.contact_id = c.id ORDER BY a.created_at DESC LIMIT 1) AS application_id
       FROM contacts c
      WHERE COALESCE(c.silo, 'BF') = 'BF'
        AND COALESCE(c.status, 'active') <> 'archived'
        AND (c.name ILIKE $1 OR c.email ILIKE $1 OR c.company_name ILIKE $1
             OR ($2 <> '' AND regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE $2))
      ORDER BY c.updated_at DESC NULLS LAST
      LIMIT 10`,
    ["%" + term + "%", digits.length >= 4 ? "%" + digits + "%" : ""],
  );
  return r.rows;
}
