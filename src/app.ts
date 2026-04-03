import express from "express";

import { corsMiddleware } from "./middleware/cors";
import routes from "./routes";
import { fail } from "./lib/response";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(corsMiddleware);

  app.get("/health", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/api/_int/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  app.use("/api/auth", require("./routes/auth").default);
  app.use("/api/v1", routes);

  app.use((_req, res) => fail(res, "not_found", 404));

  return app;
}

export function resetOtpStateForTests() {
  // No in-process OTP store is used by this app.
}

const app = createApp();

export default app;
