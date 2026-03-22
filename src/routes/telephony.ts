import express from "express";
import { ok } from "../utils/response.js";

const router = express.Router();

router.post("/token", (req, res) => {
  return res.json(ok({
    token: "mock-token",
    identity: "staff"
  }));
});

router.post("/outbound-call", (req, res) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json({
      ok: false,
      error: "Missing 'to'"
    });
  }

  return res.json(ok({
    status: "initiated",
    to
  }));
});

export default router;
