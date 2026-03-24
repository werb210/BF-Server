#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.sql>" >&2
  exit 1
fi

BACKUP_FILE="$1"
if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "Backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ -z "${VERIFY_RESTORE_DATABASE_URL:-}" ]]; then
  echo "VERIFY_RESTORE_DATABASE_URL is required" >&2
  exit 1
fi

psql "$VERIFY_RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
psql "$VERIFY_RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 < "$BACKUP_FILE"
psql "$VERIFY_RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT 1;"

echo "Restore verification passed for $BACKUP_FILE"
