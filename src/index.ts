import { app } from "./app";
import { initDb } from "@/db/init";

export default app;

if (process.env.NODE_ENV !== "test") {
  const PORT = Number(process.env.PORT) || 8080;
  void (async () => {
    await initDb();
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })();
}
