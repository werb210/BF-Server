export function validateEnv() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing env: ${key}`);
    }
  }
}
