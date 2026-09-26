// BF_SERVER_BLOCK_v552_NOTIFY_CLIENT
// One way to tell a client something. If they have the Boreal app installed
// (a push token registered for their phone) and push is configured, the notice
// goes to the app. Otherwise - no app, push not configured yet, every device
// refused it, or the app was uninstalled - it goes by SMS. Never both, never
// neither without a logged reason. Never throws.
import type { ApplicantPushCategory } from "../push/applicantPush.js";

export type ClientNotice = {
  phone: string;
  applicationId?: string | null;
  kind: string;
  sms: string;
  title: string;
  body: string;
  categoryId?: ApplicantPushCategory;
  url?: string;
  track?: { kind?: string; applicationId?: string | null }; // BF_SERVER_BLOCK_v555 - SMS delivery tracking
};
export type NoticeResult = { channel: "push" | "sms" | "none"; error?: string };

export type NotifyDeps = {
  pushReady: () => Promise<boolean>;
  pushUsersForPhone: (phone10: string) => Promise<string[]>;
  push: (userId: string, n: ClientNotice) => Promise<number>;
  sms: (phone: string, text: string, track?: { kind?: string; applicationId?: string | null }) => Promise<void>;
  record: (n: ClientNotice, phone10: string, r: NoticeResult) => Promise<void>;
};

export const phone10Of = (phone: string): string => String(phone ?? "").replace(/[^0-9]/g, "").slice(-10);

export async function notifyClient(n: ClientNotice, deps: NotifyDeps = defaultDeps): Promise<NoticeResult> {
  const phone10 = phone10Of(n.phone);
  if (phone10.length < 10) return { channel: "none", error: "no_phone" };
  let result: NoticeResult;
  try {
    let pushed = 0;
    if (await deps.pushReady().catch(() => false)) {
      for (const userId of await deps.pushUsersForPhone(phone10).catch(() => [] as string[])) {
        pushed += await deps.push(userId, n).catch(() => 0);
      }
    }
    if (pushed > 0) {
      result = { channel: "push" };
    } else {
      await deps.sms(n.phone, n.sms, n.track ?? { kind: n.kind, applicationId: n.applicationId ?? null });
      result = { channel: "sms" };
    }
  } catch (err: any) {
    result = { channel: "none", error: String(err?.message ?? err) };
    console.error("[notify-client] not_delivered", { kind: n.kind, applicationId: n.applicationId ?? null, error: result.error });
  }
  await deps.record(n, phone10, result).catch((err: any) => console.warn("[notify-client] record_failed", err?.message));
  return result;
}

const defaultDeps: NotifyDeps = {
  async pushReady() {
    const { isAnyClientPushConfigured } = await import("../clientPushService.js");
    return isAnyClientPushConfigured();
  },
  async pushUsersForPhone(phone10) {
    const { pool } = await import("../../db.js");
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM client_push_tokens
        WHERE user_id LIKE 'client:%'
          AND right(regexp_replace(coalesce(user_id,''),'[^0-9]','','g'),10) = $1`,
      [phone10],
    ).catch((err) => { console.warn("[notify-client] token_lookup_failed", err?.message); return { rows: [] as { user_id: string }[] }; });
    return rows.map((r) => r.user_id).filter(Boolean);
  },
  async push(userId, n) {
    const { sendClientPush } = await import("../clientPushService.js");
    const { applicantDeepLink } = await import("../push/applicantPush.js");
    const url = n.url ?? (n.applicationId ? applicantDeepLink(n.categoryId ?? "APPLICATION_UPDATE", n.applicationId) : "borealclient://home");
    const r = await sendClientPush({
      userId, title: n.title, body: n.body, silo: "BF", categoryId: n.categoryId ?? "APPLICATION_UPDATE", url,
      data: n.applicationId ? { applicationId: n.applicationId } : {},
    });
    return r.sent;
  },
  async sms(phone, text, track) {
    const { sendSms } = await import("../../modules/notifications/sms.service.js");
    await sendSms({ to: phone, message: text, ...(track ? { track } : {}) });
  },
  async record(n, phone10, r) {
    const { pool } = await import("../../db.js");
    await pool.query(
      `INSERT INTO client_notifications (application_id, phone10, kind, channel, error) VALUES ($1, $2, $3, $4, $5)`,
      [n.applicationId ?? null, phone10, n.kind, r.channel, r.error ?? null],
    );
  },
};
