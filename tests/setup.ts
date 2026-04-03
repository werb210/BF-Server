import { beforeAll, beforeEach } from "vitest";
import { deps } from "@/system/deps";
import { resetMetrics } from "@/system/metrics";

if (process.env.NODE_ENV === "test") {
  process.env.JWT_SECRET = "test-secret";
}

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

beforeAll(() => {
  deps.db.ready = true;
});

beforeEach(() => {
  resetMetrics();
});
