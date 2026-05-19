This directory is NOT read at startup. All migrations must live
in the top-level `migrations/` directory, which is what
src/startup/runMigrations.ts scans on boot.
