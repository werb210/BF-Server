export function validateEnv() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET",
    "NODE_ENV",
  ];

  const missing = required.filter((variable) => !process.env[variable]);

  if (missing.length) {
    console.error("Missing environment variables:", missing.join(", "));
    process.exit(1);
  }
}
