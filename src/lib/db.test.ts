// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newDb } = require("pg-mem") as { newDb: () => any };

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

let dbInstance: Queryable | null = null;

export function initializeSchema(db: any) {
  if (process.env.NODE_ENV !== "test" || process.env.DATABASE_URL) {
    throw new Error(
      "Test database schema can only be initialized when NODE_ENV is 'test' without DATABASE_URL"
    );
  }

  db.public.none(`
    CREATE TABLE IF NOT EXISTS health_check (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
}

export function resetTestDb(): void {
  const db = newDb();
  initializeSchema(db);

  const adapter = db.adapters.createPg();
  dbInstance = new adapter.Pool();
}

export function getTestDb(): Queryable {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test database is only available when NODE_ENV is 'test'");
  }

  if (process.env.DATABASE_URL) {
    throw new Error("Invalid config: DATABASE_URL must not be set in test mode");
  }

  if (!dbInstance) {
    resetTestDb();
  }

  return dbInstance as Queryable;
}

export async function withTestTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const db = getTestDb();

  await db.query("BEGIN");
  try {
    return await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}
