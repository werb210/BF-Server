import cors from "cors";
import express, { type Request, type Response } from "express";

import { auth } from "../middleware/auth";
import { errorHandler } from "../middleware/errorHandler";
import { fail, ok } from "../lib/response";
import authRoutes from "../routes/auth.routes";
import telephonyRoutes from "../routes/telephony/token";
import applicationRoutes from "../routes/application";
import documentRoutes from "../routes/documents";
import crmRoutes from "../routes/crm";

export function createServer() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  app.use(
    cors({
      origin: (origin, callback) => callback(null, origin ?? true),
      credentials: true,
      optionsSuccessStatus: 200,
    })
  );

  app.options(
    "*",
    cors({
      origin: (origin, callback) => callback(null, origin ?? true),
      credentials: true,
      optionsSuccessStatus: 200,
    })
  );

  app.get("/health", (_req: Request, res: Response) => ok(res));

  app.use("/auth", authRoutes);
  app.use("/telephony", auth, telephonyRoutes);
  app.use("/crm", auth, crmRoutes);
  app.use("/applications", applicationRoutes);
  app.use("/documents", documentRoutes);

  app.use(errorHandler);

  app.use((_: Request, res: Response) => fail(res, "not_found", 404));

  return app;
}
