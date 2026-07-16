// BF_SERVER_BLOCK_v_NOTIF_PUSH_v1
// Raise an OS-level system notification (web-push) for a notification-centre
// event, so a backgrounded PWA still pops. Best-effort / fire-and-forget.
import { pool } from "../../db.js";
import { sendNotification, type PushTarget } from "../pushService.js";

export async function pushToUser(userId: string, title: string, body: string, data = "/"): Promise<void> {
  if (!userId || !title) return;
  try {
    const r = await pool.query<{ role: string }>(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [userId]);
    const role = r.rows[0]?.role ?? "STAFF";
    await sendNotification({ userId, role } as unknown as PushTarget, {
      type: "alert",
      title,
      body: body ?? "",
      level: "normal",
      sound: true,
      data,
    });
  } catch {
    /* best-effort: never let a push failure affect the caller */
  }
}
