import { afterAll, beforeAll, beforeEach, vi } from "vitest";

process.env.NODE_ENV = "test";
process.env.SKIP_DB_CONNECTION = "true";
process.env.TEST_DB_URL = process.env.TEST_DB_URL ?? "postgres://postgres:postgres@localhost:5432/test";
process.env.DATABASE_URL = process.env.TEST_DB_URL!;
process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret";
process.env.REDIS_URL = "";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-key";
process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "ACtest";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "test-token";
process.env.TWILIO_PHONE = process.env.TWILIO_PHONE ?? "+10000000000";

vi.mock("../src/routes/routeRegistry", () => ({
  registerApiRouteMounts: vi.fn(),
}));

vi.mock("../src/services/lenderProducts/lenderProducts.service", () => ({
  lenderProductsService: {
    list: vi.fn(async () => []),
  },
}));

async function resetDatabase(): Promise<void> {
  // isolated test DB reset hook
  return Promise.resolve();
}

beforeEach(async () => {
  await resetDatabase();
});

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  process.env.SKIP_DB_CONNECTION = "true";
});

afterAll(async () => {
  // cleanup if needed
});
