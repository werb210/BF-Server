import express from "express";
import { ok } from "../utils/response.js";

const router = express.Router();

router.post("/token", (req, res) => {
  return res.json(ok({ token: "mock-twilio-token" }));
});

router.post("/outbound-call", (req, res) => {
  return res.json(ok({ status: "initiated" }));
});

export default router;
