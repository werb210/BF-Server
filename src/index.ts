import "./env";
import { createServer } from "./server/createServer";

const required = [
  "DATABASE_URL",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

const app = createServer();

const PORT = Number(process.env.PORT || 8080);

app.listen(PORT, "0.0.0.0");
