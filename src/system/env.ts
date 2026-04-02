export function validateEnv() {
  if (!process.env.PORT) throw new Error("MISSING_PORT");
  if (!process.env.JWT_SECRET) throw new Error("MISSING_JWT_SECRET");

  if (!process.env.DB_URL) throw new Error("MISSING_DB_URL");
}
