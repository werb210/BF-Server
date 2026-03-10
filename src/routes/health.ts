import { Router } from "express";
import { pool } from "../db";
import { ocrQueue } from "../queue/ocrQueue";
import { getTwilioClient } from "../services/twilio";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

router.get("/db", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "db-ok" });
});

router.get("/queue", async (_req, res) => {
  try {
    const counts = await ocrQueue.getJobCounts(
      "active",
      "waiting",
      "delayed",
      "failed",
      "completed"
    );
    res.json({ status: "queue-ok", worker: counts });
  } catch (error) {
    res.status(503).json({
      status: "queue-error",
      error: error instanceof Error ? error.message : "queue_unavailable",
    });
  }
});

router.get("/twilio", (_req, res) => {
  try {
    getTwilioClient();
    res.json({ status: "twilio-ok" });
  } catch (error) {
    res.status(503).json({
      status: "twilio-error",
      error: error instanceof Error ? error.message : "twilio_unavailable",
    });
  }
});

router.get("/ocr", async (_req, res) => {
  try {
    const waiting = await ocrQueue.getWaitingCount();
    res.json({ status: "ocr-ok", waiting });
  } catch (error) {
    res.status(503).json({
      status: "ocr-error",
      error: error instanceof Error ? error.message : "ocr_unavailable",
    });
  }
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

export default router;
