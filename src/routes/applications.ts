import express, { Request, Response } from "express";
import { ok, fail } from "../utils/response.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

type Application = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  [key: string]: any;
};

const db: Record<string, Application> = {};

router.post("/", (req: Request, res: Response) => {
  const id = Date.now().toString();

  const app: Application = {
    id,
    status: "started",
    createdAt: new Date().toISOString(),
    ...req.body
  };

  db[id] = app;

  return res.json(ok(app));
});

router.get("/:id", requireAuth, (req: Request, res: Response) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Application not found"));

  return res.json(ok(app));
});

router.patch("/:id", requireAuth, (req: Request, res: Response) => {
  const app = db[req.params.id];
  if (!app) return res.status(404).json(fail("Application not found"));

  const updated = {
    ...app,
    ...req.body,
    updatedAt: new Date().toISOString()
  };

  db[req.params.id] = updated;

  return res.json(ok(updated));
});

export default router;
