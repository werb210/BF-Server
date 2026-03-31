import dotenv from "dotenv";
import { createApp } from "./app";

dotenv.config();

function validateEnv() {
  if (!process.env.JWT_SECRET) throw new Error("[JWT_SECRET MISSING]");
  if (!process.env.DATABASE_URL) throw new Error("[DATABASE_URL MISSING]");
}

validateEnv();

const PORT = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[BOOT] ${PORT}`);
});
