// BF_SERVER_v789_JWT_SECRET_POLICY
// The only startup guard was `JWT_SECRET === "change-me-in-production"`, so any other
// placeholder ("secret", "changeme", ...) or a 3-character value booted fine and every
// staff/client token was forgeable by anyone who guessed it. This is a pure check so it
// can be unit-tested; start() in src/index.ts calls it before touching the database.

export const JWT_SECRET_MIN_LENGTH = 10;
export const JWT_SECRET_RECOMMENDED_LENGTH = 32;

// Compared case-insensitively after trimming. Keep "test-jwt-secret" / "test-secret"
// (the unit-test values) OFF this list.
export const JWT_SECRET_PLACEHOLDERS: readonly string[] = [
  "secret",
  "secretkey",
  "secret-key",
  "secret_key",
  "changeme",
  "change-me",
  "change_me",
  "changeit",
  "change-me-in-production",
  "change_me_in_production",
  "changemeinproduction",
  "your-secret",
  "your_secret",
  "yoursecret",
  "your-secret-key",
  "your_secret_key",
  "your-jwt-secret",
  "your_jwt_secret",
  "yourjwtsecret",
  "jwt_secret",
  "jwt-secret",
  "jwtsecret",
  "jwt_secret_key",
  "jwt-secret-key",
  "replace-me",
  "replace_me",
  "replaceme",
  "replace-with-a-secure-secret",
  "placeholder",
  "default",
  "test",
  "testing",
  "dev",
  "dev-secret",
  "dev_secret",
  "development",
  "local",
  "password",
  "password123",
  "supersecret",
  "super-secret",
  "super_secret",
  "mysecret",
  "my-secret",
  "my_secret",
  "123456",
  "1234567890",
  "abcdefghij",
  "todo",
  "xxx",
  "xxxxxxxxxx",
];

export type JwtSecretCheck =
  | { ok: true; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

export function checkJwtSecret(value: string | undefined | null): JwtSecretCheck {
  const secret = typeof value === "string" ? value.trim() : "";
  if (!secret) {
    return { ok: false, error: "JWT_SECRET is not set", warnings: [] };
  }
  const lower = secret.toLowerCase();
  if (JWT_SECRET_PLACEHOLDERS.includes(lower)) {
    return { ok: false, error: "JWT_SECRET is a known placeholder value", warnings: [] };
  }
  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    return {
      ok: false,
      error: `JWT_SECRET is shorter than ${JWT_SECRET_MIN_LENGTH} characters`,
      warnings: [],
    };
  }
  const warnings: string[] = [];
  if (secret.length < JWT_SECRET_RECOMMENDED_LENGTH) {
    warnings.push(
      `JWT_SECRET is ${secret.length} characters; use at least ${JWT_SECRET_RECOMMENDED_LENGTH} random characters`,
    );
  }
  return { ok: true, warnings };
}

// Throws (refusing to start) on a missing/weak/placeholder secret; logs warnings otherwise.
export function assertJwtSecretAtStartup(
  value: string | undefined | null,
  warn: (msg: string) => void = (msg) => console.warn(`[STARTUP] ${msg}`),
): void {
  const result = checkJwtSecret(value);
  for (const w of result.warnings) warn(w);
  if (!result.ok) {
    throw new Error(`[FATAL] ${result.error}. Set JWT_SECRET to a long random value.`);
  }
}
