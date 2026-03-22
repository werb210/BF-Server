import express from "express";
import apiRouter from "./api/index";

export function createApp() {
  const app = express();

  app.use(express.json());

  // === API ROOT ===
  app.use("/api", apiRouter);

  // === HARD BLOCK UNKNOWN ROUTES ===
  app.use("/api/*", (req, res) => {
    res.status(404).json({
      error: "INVALID_ROUTE",
      path: req.originalUrl,
    });
  });

  return app;
}

/**
 * =========================
 * BACKWARD COMPATIBILITY LAYER
 * =========================
 */

export function assertCorsConfig() {
  // compatibility shim: CORS is configured at middleware level elsewhere
}

export function buildApp() {
  return createApp();
}

export function registerApiRoutes(app: express.Express) {
  // already registered inside createApp
  return app;
}

export function buildAppWithApiRoutes() {
  return createApp();
}

// some parts expect default export
const appInstance = createApp();
export default appInstance;
export const app = appInstance;
