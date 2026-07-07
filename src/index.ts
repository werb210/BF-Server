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
import { startKeepWarm } from "./ops/keepWarm.js";
import { initTeamWebSocket } from "./ws/teamSocket.js"; // BF_SERVER_BLOCK_v750_TEAM_CHAT
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
    const workerStops: Array<() => void> = [];
    try { const w = startOcrWorker(); workerStops.push(w.stop); console.log("[startup] OCR worker started"); }
    catch (err) { console.error("[startup] OCR worker failed to start:", err); }
    try { const w = startBankingAutoWorker(pool); workerStops.push(w.stop); console.log("[startup] banking auto-worker started"); }
    catch (err) { console.error("[startup] banking auto-worker failed to start:", err); }

    // BF_SERVER_BLOCK_v146_LENDER_PACKAGE_WORKER_v1
    const { startLenderPackageWorker } = await import("./workers/lenderPackageWorker.js");
    try { const w = startLenderPackageWorker(pool); workerStops.push(w.stop); console.log("[startup] lender-package worker started"); }
    catch (err) { console.error("[startup] lender-package worker failed to start:", err); }

    // SignNow completion poller — embedded signing has no webhook subscription,
    // so poll document-group status and run the same finalize the webhook would.
    const { startSignNowCompletionPoller } = await import("./workers/signnowCompletionPoller.js");
    try { const w = startSignNowCompletionPoller(pool); workerStops.push(w.stop); console.log("[startup] signnow completion poller started"); }
    catch (err) { console.error("[startup] signnow completion poller failed to start:", err); }

    // Push-based completion: register the SignNow signed-event webhook (reads of
    // signed docs are denied, so the webhook is the only reliable signal).
    try { const { ensureSignnowWebhook } = await import("./signnow/ensureWebhookSubscription.js"); void ensureSignnowWebhook(); console.log("[startup] signnow webhook subscription ensured"); }
    catch (err) { console.error("[startup] signnow webhook subscription failed:", err); }

    // BF_SERVER_BLOCK_v706_READ_RECEIPTS — stamp opened_at from inbox read receipts.
    const { startReadReceiptWorker } = await import("./workers/readReceiptWorker.js");
    try { const w = startReadReceiptWorker(pool); workerStops.push(w.stop); console.log("[startup] read-receipt worker started"); }
    catch (err) { console.error("[startup] read-receipt worker failed to start:", err); }

    // BF_INBOUND_ATTACHMENT_WORKER_v1 - auto-file inbound email attachments to the CRM.
    const { startInboundAttachmentWorker } = await import("./workers/inboundAttachmentWorker.js");
    try { const w = startInboundAttachmentWorker(pool); workerStops.push(w.stop); console.log("[startup] inbound-attachment worker started"); }
    catch (err) { console.error("[startup] inbound-attachment worker failed to start:", err); }

    // BF_SERVER_BLOCK_v797_EMAIL_OPEN_TRACKING — alert the sender if a 1:1 email goes unopened for 24 business hours.
    const { startEmailFollowupWorker } = await import("./workers/emailFollowupWorker.js");
    try { const w = startEmailFollowupWorker(pool); workerStops.push(w.stop); console.log("[startup] email follow-up worker started"); }
    catch (err) { console.error("[startup] email follow-up worker failed to start:", err); }

    // BF_SERVER_PRODUCT_KNOWLEDGE_SYNC_v1 - keep Maya product knowledge in sync with lender_products (incl. manual/SQL inserts).
    const { startProductKnowledgeWorker } = await import("./workers/productKnowledgeWorker.js");
    try { const w = startProductKnowledgeWorker(pool); workerStops.push(w.stop); console.log("[startup] product-knowledge worker started"); }
    catch (err) { console.error("[startup] product-knowledge worker failed to start:", err); }

    // BF_SERVER_MARKETING_KNOWLEDGE_v1 - ingest marketing templates + collateral into Maya knowledge.
    const { startMarketingKnowledgeWorker } = await import("./workers/marketingKnowledgeWorker.js");
    try { const w = startMarketingKnowledgeWorker(pool); workerStops.push(w.stop); console.log("[startup] marketing-knowledge worker started"); }
    catch (err) { console.error("[startup] marketing-knowledge worker failed to start:", err); }

    // BF_SERVER_BLOCK_v744 — advance BI leads to Engaged on an email reply.
    const { startBiOutreachEmailReplyWorker } = await import("./workers/biOutreachEmailReplyWorker.js");
    try { const w = startBiOutreachEmailReplyWorker(pool); workerStops.push(w.stop); console.log("[startup] BI outreach email-reply worker started"); }
    catch (err) { console.error("[startup] BI outreach email-reply worker failed to start:", err); }

    const { startScheduledEmailWorker } = await import("./workers/scheduledEmailWorker.js");
    try { const w = startScheduledEmailWorker(pool); workerStops.push(w.stop); console.log("[startup] scheduled-email worker started"); }
    catch (err) { console.error("[startup] scheduled-email worker failed to start:", err); }

    const { startSmsCascadeWorker } = await import("./workers/smsCascadeWorker.js");
    try { const w = startSmsCascadeWorker(pool); workerStops.push(w.stop); console.log("[startup] sms-cascade worker started"); }
    catch (err) { console.error("[startup] sms-cascade worker failed to start:", err); }

    const { startSendQueueWorker } = await import("./workers/sendQueueWorker.js");
    try { const w = startSendQueueWorker(pool); workerStops.push(w.stop); console.log("[startup] send-queue worker started"); }
    catch (err) { console.error("[startup] send-queue worker failed to start:", err); }

    // BF_SERVER_BLOCK_v785_SEQUENCES
    const { startSequenceWorker } = await import("./workers/sequenceWorker.js");
    try { const w = startSequenceWorker(pool); workerStops.push(w.stop); console.log("[startup] sequence worker started"); }
    catch (err) { console.error("[startup] sequence worker failed to start:", err); }

    // BF_SERVER_BLOCK_v787_EMAIL_REPLY_STOP_WORKER
    const { startMailReplyWorker } = await import("./workers/mailReplyWorker.js");
    try { const w = startMailReplyWorker(pool); workerStops.push(w.stop); console.log("[startup] mail-reply worker started"); }
    catch (err) { console.error("[startup] mail-reply worker failed to start:", err); }

    // BF_SERVER_TASKS_M6_v1 - task reminders + recurrence catch-up + daily digest.
    const { startTaskRemindersWorker } = await import("./workers/taskRemindersWorker.js");
    try { const w = startTaskRemindersWorker(pool); workerStops.push(w.stop); console.log("[startup] task-reminders worker started"); }
    catch (err) { console.error("[startup] task-reminders worker failed to start:", err); }

    // BF_SERVER_BLOCK_v665 — graceful shutdown. On container recycle the workers'
    // poll loops must stop BEFORE the pool tears down, otherwise each tick queries
    // a dying pool and logs "Connection terminated due to connection timeout".
    let shuttingDown = false;
    const gracefulShutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${signal} received — stopping workers, draining pool`);
      for (const stop of workerStops) { try { stop(); } catch { /* ignore */ } }
      try { await pool.end(); } catch (err) { console.error("[shutdown] pool.end failed:", err); }
      process.exit(0);
    };
    process.on("SIGTERM", () => { void gracefulShutdown("SIGTERM"); });
    process.on("SIGINT", () => { void gracefulShutdown("SIGINT"); });
  }

  const httpServer = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on ${PORT}`);
    markReady();
    startKeepWarm();
  });
  initTeamWebSocket(httpServer); // BF_SERVER_BLOCK_v750_TEAM_CHAT
}

if (process.env.NODE_ENV !== "test") {
  start().catch(console.error);
}

