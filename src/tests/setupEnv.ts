import "./mocks/externalMocks";
import "./setup";
import { applyTestEnvDefaults } from "../test/setupEnv.js";
import { afterAll } from "vitest";

applyTestEnvDefaults();

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:5432/bf_test";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.TWILIO_ACCOUNT_SID = "AC00000000000000000000000000000000";
process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
process.env.TWILIO_API_KEY = "SK00000000000000000000000000000000";
process.env.TWILIO_API_SECRET = "test-api-secret";
process.env.REDIS_URL = "redis://127.0.0.1:6379/9";
process.env.PORT = "4000";

process.env.TWILIO_PHONE = "+10000000000";
process.env.TWILIO_VOICE_APP_SID = "AP00000000000000000000000000000000";
process.env.TEST_OTP_CODE = "123456";
process.env.SKIP_DB_CONNECTION = "true";

const originalLog = console.log;
let done = false;

console.log = (...args: unknown[]) => {
  if (done) return;
  if (args.includes("CI_TESTS_COMPLETE")) done = true;
  originalLog(...args);
};

afterAll(() => {
  if (process.env.CI_VALIDATE === "true") {
    console.log("CI_TESTS_COMPLETE");
  }
});

process.on("unhandledRejection", (err) => {
  if (String(err).toLowerCase().includes("network")) {
    throw err;
  }
});
