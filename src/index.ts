import app from "./app";
import { initDb } from "./db/init";

export async function startServer() {
  if (process.env.SKIP_DATABASE === "true") {
    console.log("DB SKIPPED");
  } else {
    try {
      await initDb();
      console.log("DB CONNECTED");
    } catch (err) {
      console.error("DB FAILED:", err);
    }
  }

  const port = Number(process.env.PORT) || 8080;

  return app.listen(port, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${port}`);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("SERVER FAILED TO START", err);
    process.exit(1);
  });
}
