process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

import "./system/errors.js";
import { createApp } from "./app.js";
import { initDb } from "./db/init.js";
import { verifyRequiredTables } from "./db/tableHealthCheck.js";
import { listRoutes } from "./debug/printRoutes.js";

const PORT = Number(process.env.PORT) || 8080;

if (process.env.NODE_ENV === "production") {
  const twilioSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim();
  const KNOWN_FAKE_SIDS = ["VA_YOUR_REAL_SERVICE_SID_HERE", "your_service_sid", "REPLACE_ME"];

  if (!twilioSid || KNOWN_FAKE_SIDS.some((fakeSid) => twilioSid.toUpperCase().includes(fakeSid.toUpperCase()))) {
    throw new Error(
      "[FATAL] TWILIO_VERIFY_SERVICE_SID must be a real Twilio Verify Service SID (starts with VA). " +
      "Get one at console.twilio.com → Verify → Services.",
    );
  }
}

export async function start(): Promise<void> {
  await initDb();
  await verifyRequiredTables([
    "users",
    "applications",
    "documents",
    "lender_products",
    "audit_events",
    "otp_verifications",
  ]);

  if (process.env.NODE_ENV !== "test") {
    try {
      const { pool } = await import("./db.js");
      const { rows } = await pool.query<{ count: number }>(
        "SELECT COUNT(*)::int AS count FROM users WHERE role = 'Admin'"
      );

      const adminCount = rows[0]?.count ?? 0;
      const shouldBootstrap = adminCount === 0 || Boolean(process.env.BOOTSTRAP_ADMIN_PHONE?.trim());

      if (shouldBootstrap) {
        if (adminCount === 0) {
          console.log("[BOOTSTRAP] No admin users found — running seed...");
        } else {
          console.log("[BOOTSTRAP] BOOTSTRAP_ADMIN_PHONE set — running seed...");
        }

        const { seedAdminUser, seedSecondAdminUser } = await import("./db/seed.js");
        await seedAdminUser();
        await seedSecondAdminUser();
        console.log("[BOOTSTRAP] Admin users seeded.");
      }
    } catch (err) {
      console.warn(
        "[BOOTSTRAP] Seed check failed (table may not exist yet):",
        String(err)
      );
    }
  }
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
