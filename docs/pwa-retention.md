# PWA Notification Retention

Use the helper service to purge stale notification audit records from `pwa_notifications`.

## Runtime usage

```ts
import { runPwaNotificationRetention } from "../src/services/pwaRetentionService";

await runPwaNotificationRetention(30);
```

## One-off command

```bash
npx tsx -e "import('./src/services/pwaRetentionService').then(async (m) => { const result = await m.runPwaNotificationRetention(Number(process.env.PWA_NOTIFICATION_RETENTION_DAYS ?? 30)); console.log(result); process.exit(0); })"
```

No scheduler is included in V1; run this via your deployment job runner or cron.
