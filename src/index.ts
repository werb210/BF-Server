process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

import "./system/errors.js";
import { createApp } from "./app.js";
import { initDb } from "./db/init.js";
import { listRoutes } from "./debug/printRoutes.js";

const PORT = Number(process.env.PORT) || 8080;

export async function start(): Promise<void> {
  await initDb();
  const app = createApp();
  const routeSet = new Set(listRoutes(app).map((entry) => `${entry.method} ${entry.path}`));
  const requiredRoutes = [
    "POST /api/auth/otp/start",
    "POST /api/auth/otp/verify",
  ];

  const missing = requiredRoutes.filter((route) => !routeSet.has(route));
  if (missing.length > 0) {
    throw new Error(`Missing required auth routes: ${missing.join(", ")}`);
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-in-production") {
    throw new Error("JWT_SECRET must be set to a secure value in production");
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SERVER STARTED ON ${PORT}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  start().catch(console.error);
}
