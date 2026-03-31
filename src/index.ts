import dotenv from "dotenv";
import { createApp } from "./app";

dotenv.config();

function validateEnv() {
  if (!process.env.JWT_SECRET) throw new Error("[JWT_SECRET MISSING]");
  if (!process.env.DATABASE_URL) throw new Error("[DATABASE_URL MISSING]");
  if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET === "test-secret") {
    throw new Error("[INVALID SECRET]");
  }
}

validateEnv();

const PORT = Number(process.env.PORT || 8080);
const app = createApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] ${PORT}`);
});
