import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { Router } from "express";

import authRoutes, { resetOtpStateForTests as resetAuthOtpStateForTests } from "./routes/auth.js";
import callRoutes from "./routes/call.js";
import healthRoutes from "./routes/health.js";
import publicRoutes from "./routes/public.js";
import { registerApiRouteMounts } from "./routes/routeRegistry.js";
import { requireAuth } from "./middleware/auth.js";
import { createLead } from "./modules/lead/lead.service.js";
import { respondOk } from "./utils/respondOk.js";
import { listRoutes } from "./debug/printRoutes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  const HARDCODED_ALLOWED_ORIGINS = [
    "https://staff.boreal.financial",
    "https://client.boreal.financial",
    "https://boreal.financial",
    "https://www.boreal.financial",
  ];

  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = [...new Set([...envOrigins, ...HARDCODED_ALLOWED_ORIGINS])];

  /**
   * CORE MIDDLEWARE
   */
  app.use(helmet({
    contentSecurityPolicy: false,
  }));

  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }));

  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());

  /**
   * HEALTH (MUST NOT BE CAUGHT BY FRONTEND)
   */
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/_int/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  /**
   * API ROUTES (LOCKED PREFIX)
   */
  const apiRouter = Router();

  apiRouter.use("/auth", authRoutes);
  apiRouter.use("/call", callRoutes);
  apiRouter.use("/health", healthRoutes);
  apiRouter.use("/public", publicRoutes);

  apiRouter.post("/voice/device-token", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { registered: true } });
  });
  apiRouter.post("/voice/calls/answer", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { answered: true } });
  });
  apiRouter.post("/voice/calls/end", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { ended: true } });
  });
  apiRouter.get("/voice/calls/log", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { calls: [] } });
  });
  apiRouter.post("/voice/record/start", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { recording: true } });
  });
  apiRouter.post("/voice/record/stop", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { recording: false } });
  });
  apiRouter.post("/sms/send", requireAuth, (_req, res) => {
    res.json({ status: "ok", data: { sent: true } });
  });
  apiRouter.post("/crm/lead", async (req: any, res: any) => {
    try {
      const payload = {
        source: req.body?.source ?? "website",
        companyName: req.body?.company_name ?? req.body?.companyName ?? req.body?.businessName,
        fullName: req.body?.full_name ?? req.body?.fullName ?? req.body?.name,
        email: req.body?.email,
        phone: req.body?.phone,
        requestedAmount: req.body?.requested_amount ?? req.body?.requestedAmount ?? req.body?.fundingAmount,
        monthlyRevenue: req.body?.monthly_revenue ?? req.body?.monthlyRevenue,
        annualRevenue: req.body?.annual_revenue ?? req.body?.annualRevenue,
        productInterest: req.body?.product_interest ?? req.body?.productInterest ?? req.body?.product,
        industryInterest: req.body?.industry_interest ?? req.body?.industryInterest ?? req.body?.industry,
        notes: req.body?.notes ?? req.body?.message,
        tags: req.body?.tags,
      };
      const result = await createLead(payload);
      return respondOk(res, result);
    } catch (err: any) {
      return res.status(500).json({ status: "error", message: err?.message ?? "Failed" });
    }
  });

  registerApiRouteMounts(apiRouter);

  // 1. API ROUTES FIRST
  app.use("/api", apiRouter);

  const routes = listRoutes(app);
  routes.forEach((entry) => {
    console.log([entry.method.toLowerCase()], entry.path);
  });

  /**
   * FRONTEND FALLBACK GUARD
   * Keep API traffic out of SPA/static fallback handlers.
   */
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.status(404).json({ error: "Route not found", path: req.originalUrl });
  });

  /**
   * 404 HANDLER
   */
  app.use("*", (req, res) => {
    res.status(404).json({ error: "Route not found", path: req.originalUrl });
  });

  /**
   * GLOBAL ERROR HANDLER
   */
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("SERVER ERROR:", err);
    res.status(500).json({
      status: "error",
      message: err?.message ?? "Internal Server Error",
    });
  });

  return app;
}

export function resetOtpStateForTests() {
  resetAuthOtpStateForTests();
}
