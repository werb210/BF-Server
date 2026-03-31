export function validateEnv() {
  if (!process.env.JWT_SECRET) {
    throw new Error("[JWT_SECRET MISSING]");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("[DATABASE_URL MISSING]");
  }
}
