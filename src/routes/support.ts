import express from "express";
import { pool } from "../db.js";

const router = express.Router();

router.post("/support", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    const result = await pool.query(
      `INSERT INTO live_chat_requests (name, email, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [name || null, email || null, message]
    );

    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Support route error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
