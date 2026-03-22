import express from "express";
import { ok, fail } from "../utils/response.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

let db = {};

router.post("/", (req, res) => {
  const id = Date.now().toString();

  db[id] = {
    id,
    status: "started",
    createdAt: new Date().toISOString(),
    ...req.body
  };

  return res.json(ok(db[id]));
});

router.get("/:id", requireAuth, (req, res) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Application not found"));

  return res.json(ok(app));
});

router.patch("/:id", requireAuth, (req, res) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Application not found"));

  db[req.params.id] = {
    ...app,
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  return res.json(ok(db[req.params.id]));
});

export default router;
