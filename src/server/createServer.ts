import cors from "cors";
import express, { type Request, type Response } from "express";

import { requireAuth } from "../middleware/requireAuth";
import authRoutes from "../modules/auth/auth.routes";
import applicationsRoutes from "../routes/applications.routes";
import documentsRoutes from "../routes/documents.routes";
import telephonyRoutes from "../routes/telephony.routes";

const leadsRoutes = express.Router();
leadsRoutes.get("/", (_req, res) => {
  res.status(200).json([]);
});

const lendersRoutes = express.Router();
lendersRoutes.post("/send", (_req, res) => {
  res.status(200).json({ status: "sent" });
});

const offersRoutes = express.Router();
offersRoutes.get("/", (_req, res) => {
  res.status(200).json({ ok: true, data: [] });
});

export function createServer() {
  const app = express();
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((origin) =>
    origin.trim(),
  ).filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : "*",
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    }),
  );
  app.options(/.*/, cors());
  app.use(express.json());

  app.use("/auth", authRoutes);

  app.use("/api/applications", requireAuth, applicationsRoutes);
  app.use("/api/leads", requireAuth, leadsRoutes);
  app.use("/api/lenders", requireAuth, lendersRoutes);
  app.use("/telephony", telephonyRoutes);
  app.use("/api/documents", requireAuth, documentsRoutes);
  app.use("/api/offers", requireAuth, offersRoutes);

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.use((req: Request, res: Response, next) => {
    if (req.path.startsWith("/api/auth") || req.path.startsWith("/api/telephony")) {
      return res.status(404).json({ error: "Deprecated route prefix" });
    }

    return next();
  });

  app.get("/debug/routes", (req, res) => {
    const routes: any[] = [];

    app._router.stack.forEach((layer: any) => {
      if (layer.route) {
        routes.push({
          path: layer.route.path,
          methods: Object.keys(layer.route.methods),
        });
      } else if (layer.name === "router") {
        layer.handle.stack.forEach((handler: any) => {
          if (handler.route) {
            routes.push({
              path: handler.route.path,
              methods: Object.keys(handler.route.methods),
            });
          }
        });
      }
    });

    res.json(routes);
  });
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      ok: false,
      error: "not_found",
    });
  });

  return app;
}
