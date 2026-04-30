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
import { pgcryptoAvailable } from "./security/ssnCrypto.js";
import { markReady } from "./startupState.js";
import { logGraphConfigStatus } from "./services/email/graphSendService.js"; // BF_SERVER_v72_BLOCK_1_5

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

  {
    const { pool } = await import("./db.js");
    const { runMigrations } = await import("./startup/runMigrations.js");
    try {
      await runMigrations(pool);
      logGraphConfigStatus(); // BF_SERVER_v72_BLOCK_1_5
      console.log("[MIGRATIONS] All migrations applied.");
      try {
        const has = await pgcryptoAvailable(pool);
        console.log(JSON.stringify({ event: "ssn_crypto_mode", mode: has ? "pgcrypto" : "node_aes_256_gcm" }));
      } catch (err) {
        console.log(JSON.stringify({ event: "ssn_crypto_mode_check_failed", error: String(err) }));
      }
    } catch (err) {
      console.error("[MIGRATIONS] FATAL — refusing to start:", err);
      // Exit so Azure App Service restarts and does not route traffic to a broken schema.
      process.exit(1);
    }
  }
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


  if (!process.env.MAYA_URL && !process.env.MAYA_SERVICE_URL) {
    console.warn(
      "[STARTUP][MAYA] MAYA_URL not set — all /api/maya/* and " +
      "/api/ai/maya/* routes will return 503. Set MAYA_URL on " +
      "App Service to the agent service URL."
    );
  }

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change-me-in-production") {
    throw new Error("JWT_SECRET must be set to a secure value in production");
  }

  // BF_AZURE_OCR_TERMSHEET_v44 — Azure Blob storage hard-check (production).
  // In development/test the storage factory falls back to LocalBackend.
  if (process.env.NODE_ENV === "production" && !process.env.AZURE_STORAGE_CONNECTION_STRING) {
    throw new Error(
      "[FATAL] AZURE_STORAGE_CONNECTION_STRING is required in production. " +
      "Set it on Azure App Service → Configuration → Application settings."
    );
  }

  // BF_AZURE_OCR_TERMSHEET_v44 — start OCR + banking auto-workers.
  // Both are no-ops if NODE_ENV=test.
  if (process.env.NODE_ENV !== "test") {
    const { pool } = await import("./db.js");
    const { startOcrWorker } = await import("./modules/ocr/ocr.worker.js");
    const { startBankingAutoWorker } = await import("./workers/bankingAutoWorker.js");
    try { startOcrWorker(); console.log("[startup] OCR worker started"); }
    catch (err) { console.error("[startup] OCR worker failed to start:", err); }
    try { startBankingAutoWorker(pool); console.log("[startup] banking auto-worker started"); }
    catch (err) { console.error("[startup] banking auto-worker failed to start:", err); }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on ${PORT}`);
    markReady();
  });
}

if (process.env.NODE_ENV !== "test") {
  start().catch(console.error);
}
