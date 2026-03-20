import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { testDb } from "./lib/db";
import { initRedis } from "./lib/redis";

dotenv.config();

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || "*",
    credentials: true,
  })
);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

async function loadRoutes(): Promise<void> {
  try {
    const routesModule = await import("./routes/index.js").catch(async () => import("./routes/index"));

    if (!routesModule || !routesModule.default) {
      console.error("❌ ROUTES NOT FOUND OR INVALID EXPORT");
      process.exit(1);
    }

    app.use("/api", routesModule.default);
    console.log("✅ Routes mounted at /api");
  } catch (err) {
    console.error("❌ FAILED TO LOAD ROUTES:", err);
    process.exit(1);
  }
}

const PORT = Number(process.env.PORT || 8080);

async function start() {
  await testDb();
  initRedis();

  await loadRoutes();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
