import cors from "cors";
import express from "express";

import routes from "./routes";
import { fail } from "./lib/response";

const allowed = [
  "https://www.borealfinancial.ca",
  "https://boreal.financial",
  "https://portal.boreal.financial",
  "https://client.boreal.financial",
];

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json());

  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed"), false);
    },
    credentials: true,
  }));

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/api/_int/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  app.use("/api/v1", routes);

  app.use((_req, res) => fail(res, "not_found", 404));

  return app;
}

export function resetOtpStateForTests() {
  // No in-process OTP store is used by this app.
}

const app = createApp();

export default app;
