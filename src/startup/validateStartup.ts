export function validateStartup() {
  const required = [
    "NODE_ENV",
    "DATABASE_URL",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET"
  ];

  const missing = required.filter(k => !process.env[k]);

  if (missing.length > 0) {
    throw new Error("Missing env vars: " + missing.join(", "));
  }
}
