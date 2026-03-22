import express, { Request, Response } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { ok, fail } from "../utils/response.js";

const router = express.Router();

router.post("/outbound-call", requireAuth, (req: Request, res: Response) => {
  const { to } = req.body;

  if (!to) {
    return res.status(400).json(fail("Missing 'to'"));
  }

  return res.json(ok({
    callSid: "mock-call-id",
    status: "initiated"
  }));
});

export default router;
