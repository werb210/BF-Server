import express from "express";
import { query } from "../db";
import { pingStorage } from "../services/storage/blobStorage";
import { getTwilioClient } from "../services/twilio";
import { ocrQueue } from "../queue/ocrQueue";

const router = express.Router();

router.get("/", (_req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

router.get("/db", async (_req, res) => {
  try {
    await query("SELECT 1");

    res.json({
      status: "db-ok",
    });
  } catch {
    res.status(500).json({
      status: "db-failed",
    });
  }
});

router.get("/storage", async (_req, res) => {
  try {
    await pingStorage();

    res.json({ status: "storage-ok" });
  } catch {
    res.status(500).json({ status: "storage-failed" });
  }
});

router.get("/twilio", async (_req, res) => {
  try {
    await getTwilioClient().api.accounts.list({ limit: 1 });

    res.json({ status: "twilio-ok" });
  } catch {
    res.status(500).json({ status: "twilio-failed" });
  }
});

router.get("/ocr", async (_req, res) => {
  try {
    await ocrQueue.getJobCounts("active");

    res.json({ status: "ocr-ok" });
  } catch {
    res.status(500).json({ status: "ocr-failed" });
  }
});

export default router;
