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
