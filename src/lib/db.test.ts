import { newDb } from "pg-mem";

let dbInstance: any;

export function getTestDb() {
  if (!dbInstance) {
    const db = newDb();

    db.public.none(`
      CREATE TABLE IF NOT EXISTS health_check (
        id SERIAL PRIMARY KEY,
        status TEXT
      );
    `);

    const adapter = db.adapters.createPg();
    dbInstance = new adapter.Pool();
  }

  return dbInstance;
}
