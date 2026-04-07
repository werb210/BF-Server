const TEST_JWT_SECRET = "test-secret";

type Env = {
  PORT?: string;
  NODE_ENV?: "development" | "test" | "production";
  JWT_SECRET: string;
  OPENAI_API_KEY?: string;
};

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    cached = {
      PORT: process.env.PORT,
      NODE_ENV: process.env.NODE_ENV as Env["NODE_ENV"],
      JWT_SECRET: process.env.JWT_SECRET || TEST_JWT_SECRET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
  }

  return cached;
}

export function validateRuntimeEnvOrExit() {
  const required = ["DATABASE_URL", "JWT_SECRET", "OPENAI_API_KEY"];

  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing env: ${key}`);
      process.exit(1);
    }
  }

  return getEnv();
}

export function resetEnvCacheForTests() {
  cached = undefined;
}
