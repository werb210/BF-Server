process.env.NODE_ENV = "test";
process.env.SKIP_DB_CONNECTION = "true";
process.env.TEST_DB_URL = "postgres://postgres:postgres@localhost:5432/test";
process.env.DATABASE_URL = process.env.TEST_DB_URL;

process.env.JWT_SECRET = "test-secret";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-token";
process.env.TWILIO_VOICE_APP_SID = "test";

process.env.REDIS_URL = "";
process.env.OPENAI_API_KEY = "test-key";
process.env.TWILIO_PHONE = "+10000000000";
process.env.TWILIO_API_KEY = "SKtest";
process.env.TWILIO_API_SECRET = "secret";
process.env.TEST_OTP_CODE = "654321";
