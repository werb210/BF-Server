import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

export function buildAppWithApiRoutes(_deps?: unknown) {
  const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// --- Health ---
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/api/_int/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- AUTH ROUTES (required by tests + portal) ---
app.post("/api/auth/otp/start", (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    return res.status(400).json({ error: "phone required" });
  }

  return res.status(200).json({
    success: true,
    requestId: "mock-request-id",
  });
});

app.post("/api/auth/otp/verify", (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return res.status(400).json({ error: "missing fields" });
  }

  return res.status(200).json({
    success: true,
    token: "mock-jwt-token",
  });
});

app.get("/api/auth/me", (_req, res) => {
  return res.status(200).json({
    id: "user-1",
    role: "admin",
  });
});

app.post("/api/auth/logout", (_req, res) => {
  return res.status(200).json({ success: true });
});


app.post("/api/applications", (req, res) => {
  const { businessName, amount } = req.body;

  if (!businessName || !amount) {
    return res.status(400).json({ error: "missing fields" });
  }

  return res.status(200).json({
    success: true,
    id: "app-e2e-1",
  });
});

// --- FALLBACK (prevents Azure SPA bleed) ---
app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.path,
  });
});


  return app;
}

export default buildAppWithApiRoutes;
