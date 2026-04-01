process.env.NODE_ENV = "test";
process.env.SKIP_DB_CONNECTION = "true";
delete process.env.DATABASE_URL;

if (process.env.NODE_ENV === "test") {
  process.env.JWT_SECRET = "test-secret";
}
process.env.TWILIO_ACCOUNT_SID = "test";
process.env.TWILIO_AUTH_TOKEN = "test";
process.env.TWILIO_VOICE_APP_SID = "test";

process.env.REDIS_URL = "";
process.env.OPENAI_API_KEY = "test-key";
process.env.TWILIO_PHONE = "+10000000000";
process.env.TWILIO_API_KEY = "SKtest";
process.env.TWILIO_API_SECRET = "secret";
process.env.TEST_OTP_CODE = "654321";
