import { runQuery } from "../db.js";

function normalizeTableName(tableName: string): string {
  const normalized = tableName.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error(`invalid_table_name:${tableName}`);
  }
  return normalized;
}

export async function verifyRequiredTables(tableNames: string[]): Promise<void> {
  const missing: string[] = [];

  for (const tableName of tableNames) {
    const normalized = normalizeTableName(tableName);
    const result = await runQuery<{ exists: string | null }>(
      "select to_regclass($1) as exists",
      [`public.${normalized}`],
    );

    if (!result.rows[0]?.exists) {
      missing.push(normalized);
    }
  }

  if (missing.length > 0) {
    throw new Error(`missing_required_tables:${missing.join(",")}`);
  }
}
