import { Router } from "express";
import { pool } from "../db";

const router = Router();

router.get("/health", async (_req, res) => {
  let db = "disconnected";
  try {
    await pool.query("select 1");
    db = "connected";
  } catch {
    db = "disconnected";
  }

  return res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    db,
  });
});

export default router;
