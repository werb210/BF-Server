export function applyTestEnvDefaults() {
  if (process.env.NODE_ENV !== "test" && process.env.CI !== "true") return;

  process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
  process.env.JWT_SECRET ??= "test-secret";
  process.env.OPENAI_API_KEY ??= "test-key";
  process.env.TWILIO_VOICE_APP_SID ??= "test-sid";
  process.env.PORT ??= "3000";
}
