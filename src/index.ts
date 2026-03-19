import express from "express";
import { testDb } from "./lib/db";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/otp/send", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/otp/verify", (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await testDb();

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
