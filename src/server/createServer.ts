import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import authRoutes from "../routes/auth.routes";

export function createServer() {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());

  app.use(cors({
    origin: [
      "https://portal.boreal.financial",
      "https://client.boreal.financial",
      "http://localhost:5173"
    ],
    credentials: true
  }));

  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);

  return app;
}
