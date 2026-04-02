import fs from "fs";
import path from "path";
import { pool, runQuery } from "./db";
import { logInfo } from "./observability/logger";

const migrationsDir = path.join(process.cwd(), "migrations");

function parseMigrationPrefix(file: string): bigint | null {
  const match = file.match(/^(\d+)(?:[_-]|\.)/);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  if (!prefix) {
    return null;
  }
  return BigInt(prefix);
}

function compareMigrationFiles(a: string, b: string): number {
  const aPrefix = parseMigrationPrefix(a);
  const bPrefix = parseMigrationPrefix(b);

  if (aPrefix !== null && bPrefix !== null && aPrefix !== bPrefix) {
    return aPrefix < bPrefix ? -1 : 1;
  }

  if (aPrefix !== null && bPrefix === null) {
    return -1;
  }

  if (aPrefix === null && bPrefix !== null) {
    return 1;
  }

  return a.localeCompare(b);
}

function findMigrationForTableCreation(
  files: string[],
  tableName: string
): string | null {
  const tablePattern = new RegExp(
    `create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+${tableName}\\b`,
    "i"
  );

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    if (tablePattern.test(sql)) {
      return file;
    }
  }

  return null;
}

function assertDocumentVersionMigrationOrder(files: string[]): void {
  const documentVersionsMigration = findMigrationForTableCreation(
    files,
    "document_versions"
  );
  const documentVersionReviewsMigration = findMigrationForTableCreation(
    files,
    "document_version_reviews"
  );

  if (!documentVersionsMigration || !documentVersionReviewsMigration) {
    return;
  }

  const versionsIndex = files.indexOf(documentVersionsMigration);
  const reviewsIndex = files.indexOf(documentVersionReviewsMigration);

  if (reviewsIndex < versionsIndex) {
    throw new Error(
      `invalid_migration_order:${documentVersionReviewsMigration} must run after ${documentVersionsMigration}`
    );
  }
}

function listMigrationFiles(): string[] {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort(compareMigrationFiles);

  assertDocumentVersionMigrationOrder(files);

  return files;
}

async function ensureMigrationsTable(): Promise<void> {
  await runQuery(
    `create table if not exists schema_migrations (
      id text,
      applied_at timestamp
    )`
  );
}

export async function assertMigrationsTableExists(): Promise<void> {
  const res = await runQuery<{ exists: string | null }>(
    "select to_regclass('public.schema_migrations') as exists"
  );
  if (!res.rows[0]?.exists) {
    throw new Error("migrations_table_missing");
  }
}

function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag: string | null = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const nextChar = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && nextChar === "/") {
        current += nextChar;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      current += char;
      if (char === "$") {
        const tagLength = dollarQuoteTag.length;
        const possibleTag = sql.slice(i - tagLength + 1, i + 1);
        if (possibleTag === dollarQuoteTag) {
          dollarQuoteTag = null;
        }
      }
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === "-" && nextChar === "-") {
        current += char + nextChar;
        i += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && nextChar === "*") {
        current += char + nextChar;
        i += 1;
        inBlockComment = true;
        continue;
      }
      if (char === "$") {
        const tagMatch = sql.slice(i).match(/^\$[a-zA-Z0-9_]*\$/);
        if (tagMatch) {
          dollarQuoteTag = tagMatch[0];
          current += tagMatch[0];
          i += tagMatch[0].length - 1;
          continue;
        }
      }
    }

    if (char === "'" && !inDoubleQuote) {
      current += char;
      if (inSingleQuote && nextChar === "'") {
        current += nextChar;
        i += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      current += char;
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ";" && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

function stripSqlComments(statement: string): string {
  return statement
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function hasExecutableSql(statement: string): boolean {
  return stripSqlComments(statement).trim().length > 0;
}

async function fetchAppliedMigrations(): Promise<Set<string>> {
  const res = await runQuery<{ id: string }>(
    "select id from schema_migrations"
  );
  return new Set(res.rows.map((row) => row.id));
}

export async function runMigrations(options?: {
  ignoreMissingRelations?: boolean;
  skipPlpgsql?: boolean;
  rewriteAlterIfExists?: boolean;
  rewriteCreateTableIfNotExists?: boolean;
  skipPgMemErrors?: boolean;
}): Promise<void> {
  await ensureMigrationsTable();
  const migrationFiles = listMigrationFiles();
  const applied = await fetchAppliedMigrations();

  for (const file of migrationFiles) {
    if (applied.has(file)) {
      continue;
    }
    const rawSql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.runQuery("begin");
      const statements = splitSql(rawSql).filter(hasExecutableSql);
      for (const statement of statements) {
        if (!hasExecutableSql(statement)) {
          continue;
        }
        const normalizedStatement = stripSqlComments(statement).trim().toLowerCase();
        if (options?.skipPlpgsql && normalizedStatement.startsWith("do $$")) {
          continue;
        }
        if (
          options?.skipPgMemErrors &&
          (normalizedStatement.startsWith("create or replace view") ||
            normalizedStatement.startsWith("create view") ||
            normalizedStatement.startsWith("create or replace function") ||
            normalizedStatement.startsWith("create function") ||
            normalizedStatement.startsWith("drop trigger") ||
            normalizedStatement.startsWith("create trigger") ||
            normalizedStatement.startsWith("create extension"))
        ) {
          continue;
        }
        if (
          options?.skipPgMemErrors &&
          normalizedStatement.startsWith("alter table") &&
          normalizedStatement.includes("add constraint") &&
          normalizedStatement.includes("check")
        ) {
          continue;
        }
        let executableStatement = statement;
        if (
          options?.rewriteAlterIfExists &&
          normalizedStatement.startsWith("alter table if exists")
        ) {
          executableStatement = statement.replace(
            /alter table if exists/i,
            "alter table"
          );
        }
        if (
          options?.rewriteCreateTableIfNotExists &&
          normalizedStatement.startsWith("create table if not exists")
        ) {
          executableStatement = statement.replace(
            /create table if not exists/i,
            "create table"
          );
        }
        try {
          await client.runQuery(executableStatement);
        } catch (err) {
          if (options?.ignoreMissingRelations) {
            const message = err instanceof Error ? err.message : String(err);
            if (
              normalizedStatement.startsWith("alter table if exists") &&
              message.includes("does not exist")
            ) {
              continue;
            }
            if (
              (normalizedStatement.startsWith("create index if not exists") ||
                normalizedStatement.startsWith("create unique index if not exists")) &&
              message.includes("does not exist")
            ) {
              continue;
            }
            if (
              normalizedStatement.startsWith("insert into ocr_results") &&
              message.includes("does not exist")
            ) {
              continue;
            }
            if (
              normalizedStatement.startsWith("update document_processing_jobs") &&
              message.includes("does not exist")
            ) {
              continue;
            }
            if (
              normalizedStatement.startsWith("update ") &&
              message.includes("does not exist")
            ) {
              continue;
            }
          }
          if (options?.skipPgMemErrors) {
            const message = err instanceof Error ? err.message : String(err);
            if (
              message.includes("cannot cast type timestamp without time zone to text") &&
              normalizedStatement.includes("idempotency_keys")
            ) {
              continue;
            }
            if (
              message.includes("Unexpected kw_using token") &&
              normalizedStatement.startsWith("alter table")
            ) {
              continue;
            }
            if (message.includes("Foreign key column type mismatch")) {
              continue;
            }
            if (
              message.includes("Column") &&
              message.includes("not found") &&
              normalizedStatement.startsWith("alter table")
            ) {
              continue;
            }
            if (
              message.includes('column "status" does not exist') &&
              normalizedStatement.startsWith("update users") &&
              normalizedStatement.includes("set status")
            ) {
              continue;
            }
            if (
              message.includes('type "call_direction_enum" does not exist') ||
              message.includes('type "call_status_enum" does not exist')
            ) {
              continue;
            }
            if (
              message.toLowerCase().includes('type "vector') ||
              message.toLowerCase().includes("extension does not exist: vector")
            ) {
              continue;
            }
          }
          if (
            options?.rewriteCreateTableIfNotExists &&
            normalizedStatement.startsWith("create table if not exists")
          ) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("already exists")) {
              continue;
            }
          }
          throw err;
        }
      }
      await client.runQuery(
        "insert into schema_migrations (id, applied_at) values ($1, now())",
        [file]
      );
      logInfo("migration_applied", { migration: file });
      await client.runQuery("commit");
    } catch (err) {
      await client.runQuery("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function fetchPendingMigrations(): Promise<string[]> {
  await ensureMigrationsTable();
  const migrationFiles = listMigrationFiles();
  const applied = await fetchAppliedMigrations();
  return migrationFiles.filter((file) => !applied.has(file));
}

export async function assertNoPendingMigrations(): Promise<void> {
  const pending = await fetchPendingMigrations();
  if (pending.length > 0) {
    throw new Error(`pending_migrations:${pending.join(",")}`);
  }
}

export async function fetchSchemaVersion(): Promise<string> {
  await ensureMigrationsTable();
  const res = await runQuery<{ id: string }>(
    `select id
     from schema_migrations
     order by applied_at desc, id desc
     limit 1`
  );
  const latest = res.rows[0]?.id;
  if (!latest) {
    throw new Error("schema_version_missing");
  }
  return latest;
}
