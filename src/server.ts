import express from "express";
import { getDb } from "./lib/db";

export const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const PORT = process.env.PORT || 8080;

async function assertDb() {
  try {
    await getDb().query("SELECT 1");
  } catch (e) {
    console.error("DB connection failed", e);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void (async () => {
    await assertDb();
    app.listen(PORT, () => {
      console.log(`Server running on ${PORT}`);
    });
  })();
}
