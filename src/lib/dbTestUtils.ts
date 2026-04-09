import { newDb } from "pg-mem";

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

let dbInstance: Queryable | null = null;

export function createTestDb() {
  const db = newDb();
  const pg = db.adapters.createPg();

  return {
    db,
    pg,
  };
}

export async function resetTestDb(): Promise<void> {
  const { pg } = createTestDb();
  dbInstance = new pg.Pool();
}

export function getTestDb(): Queryable {
  if (!dbInstance) {
    throw new Error("Test database is not initialized. Call resetTestDb() first.");
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
