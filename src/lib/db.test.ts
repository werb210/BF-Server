import { newDb } from "pg-mem";

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

let dbInstance: Queryable | null = null;

export function initializeSchema(db: ReturnType<typeof newDb>) {
  db.public.none(`
    CREATE TABLE IF NOT EXISTS health_check (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
}

export function getTestDb(): Queryable {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Test database is only available when NODE_ENV is 'test'");
  }

  if (!dbInstance) {
    const db = newDb();
    initializeSchema(db);

    const adapter = db.adapters.createPg();
    dbInstance = new adapter.Pool();
  }

  return dbInstance;
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
