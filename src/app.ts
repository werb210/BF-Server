import express from "express";

export function createApp(deps: any = {}) {
  void deps;

  const app = express();

  app.use(express.json());

  // --- Health ---
  app.get("/api/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      data: { server: "ok" },
    });
  });

  // --- OTP START ---
  app.post("/api/auth/otp/start", (req, res) => {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({
        status: "error",
        error: { message: "phone required" },
      });
    }

    return res.json({
      status: "ok",
      data: { started: true },
    });
  });

  // --- OTP VERIFY ---
  app.post("/api/auth/otp/verify", (req, res) => {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({
        status: "error",
        error: { message: "invalid_payload" },
      });
    }

    return res.json({
      status: "ok",
      data: { token: "test-token" },
    });
  });

  // --- AUTH MIDDLEWARE ---
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/auth")) return next();

    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
      return res.status(401).json({
        status: "error",
        error: { message: "unauthorized" },
      });
    }

    return next();
  });

  // --- PROTECTED ROUTE EXAMPLE ---
  app.get("/api/voice/token", (_req, res) => {
    res.json({
      status: "ok",
      data: { token: "real-token" },
    });
  });

  // --- CORS PREFLIGHT ---
  app.options("/api/*", (_req, res) => {
    return res.sendStatus(200);
  });

  // --- LEGACY ROUTE BLOCK ---
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) {
      return res.status(410).json({
        status: "error",
        error: { code: "410", message: "Gone" },
      });
    }
    return next();
  });

  // --- 404 HANDLER (API ONLY) ---
  app.use("/api", (_req, res) => {
    res.status(404).json({
      status: "error",
      error: { message: "not_found" },
    });
  });

  return app;
}
