#!/usr/bin/env bash
# Generates migrations/000_baseline.sql from the current live database.
# Run once after merging the archive-migrations branch.
# Requires: pg_dump, DATABASE_URL environment variable.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/dbname bash scripts/generate-baseline.sh

set -euo pipefail

MIGRATIONS_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"
OUTPUT="$MIGRATIONS_DIR/000_baseline.sql"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

echo "Generating baseline from $DATABASE_URL ..."

pg_dump "$DATABASE_URL" \
  --schema-only \
  --no-owner \
  --no-acl \
  --no-comments \
  --exclude-table=schema_migrations \
  | grep -v '^--' \
  | sed '/^[[:space:]]*$/d' \
  > "$OUTPUT"

echo "Written to $OUTPUT"
echo "Review the file, then: git add migrations/000_baseline.sql && git commit -m 'chore: add squashed baseline'"
