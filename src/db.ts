/**
 * Database module resolver.
 * Uses the production Postgres pool implementation in all environments.
 */

import * as dbProd from "./db.prod";

const dbImpl = dbProd;

export const {
  pool,
  db,
  query,
  getClient,
  dbQuery,
  assertPoolHealthy,
  checkDb,
  warmUpDatabase,
  getInstrumentedClient,
  setDbTestPoolMetricsOverride,
  setDbTestFailureInjection,
  clearDbTestFailureInjection,
} = dbImpl;
