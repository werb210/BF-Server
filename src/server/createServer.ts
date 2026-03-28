import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";

import { auth } from "../middleware/auth";
import authRoutes from "../routes/auth.routes";
import telephonyRoutes from "../routes/telephony/token";
import applicationRoutes from "../routes/application";
import documentRoutes from "../routes/documents";
import crmRoutes from "../routes/crm";
import lenderRoutes from "../modules/lender/lender.routes";
import { fail } from "../utils/response";

export function createServer() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  app.use(
    cors({
      origin: true,
      credentials: true,
      optionsSuccessStatus: 200,
    })
  );
  app.options("*", cors({ origin: true, credentials: true, optionsSuccessStatus: 200 }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ success: true });
  });

  app.use("/auth", authRoutes);
  app.use("/telephony", auth, telephonyRoutes);
  app.use("/api/applications", applicationRoutes);
  app.use("/api/documents", documentRoutes);
  app.use("/api/crm", auth, crmRoutes);
  app.use("/api/lenders", auth, lenderRoutes);

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error(err);

    res.status(500).json(
      fail(err?.message || "Internal server error")
    );
  });

  app.use((_: Request, res: Response) => {
    res.status(404).json(fail("not_found"));
  });

  return app;
}
