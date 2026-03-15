const requiredInProduction = [
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "DATABASE_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;

if ((process.env.NODE_ENV ?? "development") === "production") {
  requiredInProduction.forEach((variable) => {
    if (!process.env[variable]) {
      throw new Error(`Missing env variable ${variable}`);
    }
  });
}

export {};
