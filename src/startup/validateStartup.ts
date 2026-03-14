export function validateStartup() {
  process.env.NODE_ENV ||= "development";

  if (process.env.NODE_ENV !== "production") {
    process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/staff_dev";
    return;
  }

  const required = ["NODE_ENV", "DATABASE_URL"];

  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    console.error("Missing environment variables:", missing.join(", "));
    process.exit(1);
  }

  console.log("Startup validation passed");
}
