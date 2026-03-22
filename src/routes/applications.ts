import express from "express";
import { ok, fail } from "../utils/response.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

type ApplicationRecord = {
  id: string;
  status: string;
  [key: string]: unknown;
};

const db: Record<string, ApplicationRecord> = {};

router.post("/", async (req, res) => {
  const id = Date.now().toString();
  db[id] = { id, ...req.body, status: "started" };
  return res.json(ok(db[id]));
});

router.get("/:id", requireAuth, async (req, res) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Not found"));
  return res.json(ok(app));
});

router.patch("/:id", requireAuth, async (req, res) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Not found"));

  db[req.params.id] = { ...app, ...req.body };
  return res.json(ok(db[req.params.id]));
});

export default router;
