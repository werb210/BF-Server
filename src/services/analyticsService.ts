import { dbQuery } from "../db.js";
import { logInfo } from "../observability/logger.js";

type LogAnalyticsEventInput = {
  event: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

export async function logAnalyticsEvent({
  event,
  metadata = {},
  ip,
  userAgent,
}: LogAnalyticsEventInput): Promise<void> {
  await dbQuery(
    `insert into analytics_events (event, metadata, ip, user_agent)
     values ($1, $2::jsonb, $3, $4)`,
    [event, JSON.stringify(metadata), ip ?? null, userAgent ?? null]
  );

  logInfo("audit_analytics_event_logged", {
    event,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
  });
}
