import cors from "cors";
import express, { type Request, type Response } from "express";

import { requireAuth } from "../middleware/requireAuth";
import applicationsRoutes from "../routes/applications.routes";
import authRoutes from "../routes/auth.routes";
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
  app.use(
    cors({
      origin: [
        "https://staff.boreal.financial",
        "https://client.boreal.financial",
      ],
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    }),
  );
  app.use(express.json());

  // PUBLIC ROUTES (NO AUTH)
  app.use("/auth", authRoutes);

  // PROTECTED ROUTES
  app.use("/api/applications", requireAuth, applicationsRoutes);
  app.use("/api/leads", requireAuth, leadsRoutes);
  app.use("/api/lenders", requireAuth, lendersRoutes);
  app.use("/telephony", requireAuth, telephonyRoutes);
  app.use("/api/documents", requireAuth, documentsRoutes);
  app.use("/api/offers", requireAuth, offersRoutes);

  app.get("/health", (_req: Request, res: Response) => {
    res.send("ok");
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
