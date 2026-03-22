import { assertCriticalRoutes } from "./_internal/routeAudit";
import express from "express";
import { registerApiRouteMounts } from "./routes/routeRegistry";

export function buildApi() {
  const app = express();

  app.use(express.json());

  // HEALTH
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/_int/routes", (req, res) => {
    const { auditRoutes } = require("./_internal/routeAudit");
    res.json(auditRoutes(app));
  });

  // ROUTES (ONLY SOURCE OF TRUTH)
  registerApiRouteMounts(app);
  assertCriticalRoutes(app);

  // FALLBACK
  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  return app;
}

export default buildApi;
