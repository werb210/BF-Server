import express from "express";
import { registerApiRouteMounts } from "./routes/routeRegistry";

export function buildApi() {
  const app = express();

  app.use(express.json());

  // HEALTH
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ROUTES (ONLY SOURCE OF TRUTH)
  registerApiRouteMounts(app);

  // FALLBACK
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}

export default buildApi;
