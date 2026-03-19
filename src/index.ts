import express from "express";
import { testDb } from "./lib/db";

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await testDb(); // fail if DB is broken

  app.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("FATAL START ERROR:", err);
  process.exit(1);
});
