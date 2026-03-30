import express from "express";
import cors from "cors";
import authRoutes from "../routes/auth.routes";
import applicationRoutes from "../routes/applications.routes";
import documentRoutes from "../routes/documents";

export function createServer() {
  const app = express();

  app.use(express.json());

  app.use(cors({
    origin: [
      "https://portal.boreal.financial",
      "https://client.boreal.financial",
      "http://localhost:4173",
      "http://localhost:3000"
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false
  }));

  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/application", applicationRoutes);
  app.use("/api/documents", documentRoutes);

  return app;
}
