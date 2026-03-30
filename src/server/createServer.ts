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

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).send("OK");
  });

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

  app.get("/", (_req: Request, res: Response) => res.status(200).send("Server is running"));

  app.use("/auth", authRoutes);
  app.use("/telephony", auth, telephonyRoutes);
  app.use("/crm", auth, crmRoutes);
  app.use("/applications", applicationRoutes);
  app.use("/documents", documentRoutes);

  app.use(errorHandler);
  app.use((_: Request, res: Response) => fail(res, "not_found", 404));

  const requiredRoutes = ["/health", "/auth", "/telephony", "/crm", "/applications"];
  const stack = ((app as any)._router?.stack ?? []) as Array<{ route?: { path?: string }; regexp?: RegExp; name?: string }>;

  for (const route of requiredRoutes) {
    const mounted = stack.some((layer) => {
      if (layer.route?.path === route) {
        return true;
      }

      if (layer.name === "router" && layer.regexp) {
        return layer.regexp.toString().includes(route.replace("/", "\\/"));
      }

      return false;
    });

    if (!mounted) {
      throw new Error(`MISSING_ROUTE: ${route}`);
    }
  }

  return app;
}
