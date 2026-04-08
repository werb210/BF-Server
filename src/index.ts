import app from "./app";
import { validateEnv } from "./config/env";

const PORT = process.env.PORT || 8080;

async function start() {
  try {
    // Only validate env — do NOT call external services
    validateEnv();

    app.listen(PORT, () => {
      console.log(`SERVER STARTED ON ${PORT}`);
    });

  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
}

start();
