import express from "express";
import { runQuery } from "./lib/db";

export const app = express();

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const PORT = process.env.PORT || 8080;

async function startServer() {
  if (process.env.NODE_ENV !== "test") {
    try {
      await runQuery("SELECT 1");
    } catch {
      console.error("DB not ready, exiting");
      process.exit(1);
    }
  }

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  void startServer();
}
