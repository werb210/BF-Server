const DEFAULT_TEST_ENV: Record<string, string> = {
  NODE_ENV: "test",
  SKIP_DB_CONNECTION: "true",
  TEST_DB_URL: "postgres://postgres:postgres@localhost:5432/test",
  JWT_SECRET: "test-secret",
  REDIS_URL: "",
  OPENAI_API_KEY: "test-key",
  TWILIO_ACCOUNT_SID: "ACtest",
  TWILIO_AUTH_TOKEN: "test-token",
  TWILIO_PHONE: "+10000000000",
  TWILIO_VOICE_APP_SID: "APtest",
  TWILIO_API_KEY: "SKtest",
  TWILIO_API_SECRET: "secret",
  TEST_OTP_CODE: "123456",
};

export function loadTestEnv(overrides: Partial<Record<string, string>> = {}): void {
  const merged = { ...DEFAULT_TEST_ENV, ...overrides };

  for (const [key, value] of Object.entries(merged)) {
    process.env[key] = value;
  }

  process.env.DATABASE_URL = process.env.TEST_DB_URL;
}

export function clearJwtSecretForAuthFailure(): void {
  delete process.env.JWT_SECRET;
}
