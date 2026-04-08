import "./mocks/externalMocks";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test_db";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-key";
process.env.TWILIO_ACCOUNT_SID =
  process.env.TWILIO_ACCOUNT_SID || "ACxxxxxxxx";
process.env.TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "test-token";
process.env.TWILIO_PHONE = process.env.TWILIO_PHONE || "+10000000000";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.TWILIO_VOICE_APP_SID = process.env.TWILIO_VOICE_APP_SID || "test";
process.env.TWILIO_API_KEY = process.env.TWILIO_API_KEY || "SKtest";
process.env.TWILIO_API_SECRET = process.env.TWILIO_API_SECRET || "secret";
process.env.TEST_OTP_CODE = process.env.TEST_OTP_CODE || "654321";
process.env.PORT = process.env.PORT || "4000";
