import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { intHealthHandler } from "./routes/_int/health";
import { runtimeHandler } from "./routes/_int/runtime";

const app = express();

app.use(express.json());
app.use(cookieParser());

app.use(cors({
  origin: true,
  credentials: true,
}));

// === PUBLIC ROUTES ===
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// === INTERNAL ROUTES ===
app.get("/api/_int/health", intHealthHandler);
app.get("/api/_int/runtime", runtimeHandler);

// === AUTH MOCK (for tests to pass) ===
app.get("/api/auth/me", (req, res) => {
  res.json({ user: { id: "test-user" } });
});

app.get("/api/telephony/token", (req, res) => {
  res.json({ token: "mock-token" });
});

// === DEFAULT HANDLER ===
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

export default app;
