/**
 * Production vs test DB module resolver.
 * - test: in-memory pg-mem adapter
 * - otherwise: real Postgres pool
 */

import * as dbProd from "./db.prod";
import * as dbTest from "./dbTest";

const dbImpl = process.env.NODE_ENV === "test" ? dbTest : dbProd;

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
