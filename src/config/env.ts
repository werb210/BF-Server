export function validateEnv() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "OPENAI_API_KEY"
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL as string,
    JWT_SECRET: process.env.JWT_SECRET as string,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY as string,
    NODE_ENV: process.env.NODE_ENV || "production",
    PORT: Number(process.env.PORT || 8080)
  };
}
