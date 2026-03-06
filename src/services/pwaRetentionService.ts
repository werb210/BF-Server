import { purgeOldPwaNotifications } from "../repositories/pwa.repo";

export async function runPwaNotificationRetention(retentionDays = 30): Promise<{ purged: number }> {
  const normalizedDays = Number.isFinite(retentionDays)
    ? Math.max(1, Math.floor(retentionDays))
    : 30;
  const purged = await purgeOldPwaNotifications(normalizedDays);
  return { purged };
}
