// BF_SERVER_v869_PHONE_MENU - the saved phone menu and its uploaded recordings
// (migrations/2026_11_10_v869_settings_pack.sql). Ported from KS-server #38. No saved menu = Boreal's live menu.
import { defaultBorealMenu, isRoleRef, type MenuUser, type PhoneMenu, type RoleRef } from "./menu.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const AUDIO_TYPES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"] as const;
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

/** Active Admin and Staff users: who a menu can ring. */
export async function activeMenuUsers(db: Q): Promise<MenuUser[]> {
  const r = await db.query(
    `SELECT id::text AS id, first_name, last_name, role FROM users
      WHERE COALESCE(active, true) AND COALESCE(disabled, false) = false AND deleted_at IS NULL
        AND role IN ('Admin', 'Staff')
      ORDER BY (role = 'Admin') DESC, first_name NULLS LAST, last_name NULLS LAST
      LIMIT 200`,
  );
  return r.rows as MenuUser[];
}

/** Who the default menu's reception roles point at today (same rule the receptionist has always used). */
export async function roleRefIds(db: Q): Promise<Record<RoleRef, string | null>> {
  const pinned = (raw: unknown) => { const id = String(raw ?? "").trim(); return /^[0-9a-f-]{36}$/i.test(id) ? id : null; };
  const one = async (first: string, pin: string | null): Promise<string | null> => {
    if (pin) return pin;
    const r = await db.query(
      `SELECT id::text AS id FROM users WHERE first_name ILIKE $1 AND COALESCE(active, true) = true ORDER BY created_at ASC NULLS LAST LIMIT 1`, [first]);
    return r.rows[0]?.id ? String(r.rows[0].id) : null;
  };
  return {
    "@sales": await one("todd", pinned(process.env.RECEPTION_SALES_USER_ID)),
    "@underwriting": await one("andrew", pinned(process.env.RECEPTION_UNDERWRITING_USER_ID)),
  };
}

export type LoadedMenu = { menu: PhoneMenu; isDefault: boolean; updatedAt: string | null };

/** The saved menu, or Boreal's live menu when none is saved. A read failure is logged and the live menu answers the
 *  call: a caller must never hear an error because Settings could not be read. */
export async function loadMenu(db: Q): Promise<LoadedMenu> {
  try {
    const r = await db.query(`SELECT config, updated_at FROM phone_menu_config WHERE id = 1`);
    const row = r.rows?.[0];
    if (row?.config && typeof row.config === "object" && Array.isArray(row.config.options)) {
      return { menu: row.config as PhoneMenu, isDefault: false, updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null };
    }
  } catch (err) {
    console.error("[phone-menu] saved menu could not be read; using the default menu", { message: err instanceof Error ? err.message : String(err) });
  }
  return { menu: defaultBorealMenu(), isDefault: true, updatedAt: null };
}

export async function saveMenu(db: Q, menu: PhoneMenu, actorId: string | null): Promise<void> {
  await db.query(
    `INSERT INTO phone_menu_config (id, config, updated_at, updated_by) VALUES (1, $1::jsonb, now(), $2::uuid)
     ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify(menu), actorId],
  );
}

/** Back to Boreal's default menu (deletes the saved one). */
export async function resetMenu(db: Q): Promise<void> {
  await db.query(`DELETE FROM phone_menu_config WHERE id = 1`);
}

export type AudioRow = { id: string; file_name: string | null; content_type: string; size_bytes: number; created_at: string };

export async function listAudio(db: Q): Promise<AudioRow[]> {
  const r = await db.query(`SELECT id::text AS id, file_name, content_type, size_bytes, created_at FROM phone_menu_audio ORDER BY created_at DESC LIMIT 50`);
  return r.rows as AudioRow[];
}

export async function saveAudio(db: Q, file: { name: string | null; type: string; bytes: Buffer }, actorId: string | null): Promise<AudioRow> {
  const r = await db.query(
    `INSERT INTO phone_menu_audio (file_name, content_type, size_bytes, bytes, created_by) VALUES ($1, $2, $3, $4, $5::uuid)
     RETURNING id::text AS id, file_name, content_type, size_bytes, created_at`,
    [file.name ? file.name.slice(0, 120) : null, file.type, file.bytes.length, file.bytes, actorId],
  );
  return r.rows[0] as AudioRow;
}

export async function readAudio(db: Q, id: string): Promise<{ content_type: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.query(`SELECT content_type, bytes FROM phone_menu_audio WHERE id::text = $1 LIMIT 1`, [id]);
  return r.rows[0] ? { content_type: String(r.rows[0].content_type), bytes: r.rows[0].bytes as Buffer } : null;
}

export async function deleteAudio(db: Q, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM phone_menu_audio WHERE id::text = $1 RETURNING id`, [id]);
  return (r.rows ?? []).length > 0;
}

/** True when a file's first bytes look like MP3 or WAV (the types Twilio's <Play> handles). */
export function looksLikeAudio(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return true;
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return true;
  return bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0; // MPEG frame sync
}

export { isRoleRef };
