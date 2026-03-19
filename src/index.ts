import 'dotenv/config';

import express from "express";
import { testDb } from "./lib/db";
import { initRedis } from "./lib/redis";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/auth/otp/send", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/auth/otp/verify", (_req, res) => {
  res.status(200).json({ ok: true });
});

const PORT = Number(process.env.PORT || 3000);

async function start() {
  await testDb();
  initRedis();

  app.listen(PORT, () => {
    console.log(`SERVER STARTED on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
