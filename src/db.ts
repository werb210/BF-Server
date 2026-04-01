import * as dbProd from "./db.prod";

const dbImpl = dbProd;

export const {
  pool,
  db,
  query,
  fetchClient,
  dbQuery,
  assertPoolHealthy,
  checkDb,
  warmUpDatabase,
  fetchInstrumentedClient,
  setDbTestPoolMetricsOverride,
  setDbTestFailureInjection,
  clearDbTestFailureInjection,
} = dbImpl;

let dbReady = false;

export async function ensureDb(): Promise<void> {
  try {
    await pool.query("SELECT 1");
    dbReady = true;
    console.log("DB connected");
  } catch {
    dbReady = false;
    console.warn("DB unavailable — continuing without DB");
  }
}

export function isDbReady(): boolean {
  return dbReady;
}


const dbExports = {
  pool,
  db,
  query,
  fetchClient,
  dbQuery,
  assertPoolHealthy,
  checkDb,
  warmUpDatabase,
  fetchInstrumentedClient,
  setDbTestPoolMetricsOverride,
  setDbTestFailureInjection,
  clearDbTestFailureInjection,
};

export default dbExports;
