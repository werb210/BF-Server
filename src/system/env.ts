export function validateEnv() {
  const NODE_ENV = process.env.NODE_ENV ?? "production";
  const PORT = Number(process.env.PORT || 8080);

  if (Number.isNaN(PORT)) {
    throw new Error("INVALID_PORT");
  }

  if (NODE_ENV !== "test" && !process.env.DB_URL) {
    throw new Error("MISSING_DB_URL");
  }
}
