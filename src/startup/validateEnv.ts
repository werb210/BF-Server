export function validateEnv() {
  const nodeEnv = process.env.NODE_ENV || "development";
  process.env.NODE_ENV = nodeEnv;

  if (nodeEnv !== "production") {
    process.env.OTP_HASH_SECRET ||= "dev-otp-hash-secret";
    process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/staff_dev";
    process.env.JWT_SECRET ||= "dev-jwt-secret";
    process.env.JWT_REFRESH_SECRET ||= "dev-jwt-refresh-secret";
    return;
  }

  const required = [
    "OTP_HASH_SECRET",
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
