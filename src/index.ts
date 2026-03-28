import { createServer } from "./server/createServer";

const required = [
  "JWT_SECRET",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE",
  "REDIS_URL",
] as const;

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing env var: ${key}`);
  }
}

const app = createServer();

const port = process.env.PORT || "8080";

app.listen(Number(port), "0.0.0.0", () => {
  console.log(`Server running on ${port}`);
});
