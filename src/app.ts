import express from "express";

/**
 * CORE APP BUILDER
 */
export function buildApp() {
  const app = express();

  app.use(express.json());

  return app;
}

/**
 * ROUTE REGISTRATION
 */
export function registerApiRoutes(app: express.Express) {
  // health
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // runtime
  app.get("/_int/runtime", (_req, res) => {
    res.json({ status: "running" });
  });

  // OTP start
  app.post("/auth/otp/start", (req, res) => {
    const { phone } = req.body;

    res.json({
      success: true,
      phone,
      otp: "123456", // test mode
    });
  });

  // OTP verify
  app.post("/auth/otp/verify", (_req, res) => {
    res.json({
      success: true,
      token: "test-token",
    });
  });

  // me
  app.get("/auth/me", (_req, res) => {
    res.json({
      user: { id: "test-user" },
    });
  });

  // logout
  app.post("/auth/logout", (_req, res) => {
    res.json({ success: true });
  });
}

/**
 * FULL APP BUILDER (LEGACY COMPAT)
 */
export function buildAppWithApiRoutes() {
  const app = buildApp();
  registerApiRoutes(app);
  return app;
}

/**
 * CORS CHECK (stub)
 */
export function assertCorsConfig() {
  return true;
}

/**
 * DEFAULT APP EXPORT (for older imports)
 */
const app = buildAppWithApiRoutes();

export default app;
export { app };
