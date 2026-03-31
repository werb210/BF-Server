import dotenv from "dotenv";
import { createApp } from "./app";
import { validateEnv } from "./server";

dotenv.config();

validateEnv();

const PORT = Number(process.env.PORT || 8080);
const app = createApp();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});
