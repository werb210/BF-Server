# Database Backup and Restore

## Backup policy

- Run backups **daily** via scheduler/cron.
- Command:
  - `npm run db:backup`

### Example cron (UTC 02:00 daily)

```cron
0 2 * * * cd /workspace/BF-Server && DATABASE_URL="$DATABASE_URL" npm run db:backup
```

## Restore verification policy

- Every daily backup must have restore verification.
- Command:
  - `VERIFY_RESTORE_DATABASE_URL=... npm run db:verify-restore -- backups/backup-YYYYMMDDTHHMMSSZ.sql`

This ensures backup files are recoverable, not just generated.
