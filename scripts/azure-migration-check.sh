#!/usr/bin/env bash
# BF_SERVER_v882_AZURE_MIGRATION_CHECK - runs every migration the way Azure Database for PostgreSQL would:
# as a role that is NOT a superuser, with only the allow-listed extensions (vector) available. CI's own database is
# a superuser on plain Postgres, which is how CREATE EXTENSION pgcrypto passed CI and then stopped the server
# starting on Azure (2026-11-02). Usage: scripts/azure-migration-check.sh  (needs psql and PG* env for a superuser)
set -euo pipefail
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
DB=azure_sim
psql -v ON_ERROR_STOP=1 -q -d postgres <<SQL
DROP DATABASE IF EXISTS $DB;
DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'azure_admin') THEN DROP OWNED BY azure_admin; DROP ROLE azure_admin; END IF; END \$\$;
CREATE ROLE azure_admin LOGIN PASSWORD 'azure_admin' NOSUPERUSER CREATEROLE;
CREATE DATABASE $DB OWNER azure_admin;
SQL
psql -v ON_ERROR_STOP=1 -q -d "$DB" <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
ALTER SCHEMA public OWNER TO azure_admin;
CREATE OR REPLACE FUNCTION azure_extension_allow_list() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_query() !~* 'extension\s+(if\s+not\s+exists\s+)?"?(vector|plpgsql)"?(\s|;|$)' THEN
    RAISE EXCEPTION 'extension is not allow-listed on Azure Database for PostgreSQL: %', current_query() USING ERRCODE = '0A000';
  END IF;
END $$;
CREATE EVENT TRIGGER azure_extension_allow_list ON ddl_command_start WHEN TAG IN ('CREATE EXTENSION')
  EXECUTE FUNCTION azure_extension_allow_list();
SQL
DATABASE_URL="postgres://azure_admin:azure_admin@${PGHOST}:${PGPORT}/${DB}" NODE_ENV=test npx tsx -e "import('./src/db.js').then(async ({ pool }) => { try { const { runMigrations } = await import('./src/startup/runMigrations.js'); await runMigrations(pool); console.log('azure-like migrations applied'); } finally { await pool.end(); } }).catch((err) => { console.error('migrations failed under Azure rules:', err?.message ?? err); process.exit(1); })"
