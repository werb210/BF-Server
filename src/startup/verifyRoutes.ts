import type express from "express";
import { listRoutes } from "../debug/printRoutes";

const REQUIRED_ROUTES = [
  "/api/client/applications",
  "/api/documents",
  "/api/lenders",
  "/api/lenders/send",
  "/api/banking",
  "/api/credit",
  "/api/health",
] as const;

export function verifyRoutes(app: express.Express): void {
  const mountedPaths = listRoutes(app).map((route) => route.path);

  REQUIRED_ROUTES.forEach((requiredPath) => {
    const routeExists = mountedPaths.some(
      (mountedPath) =>
        mountedPath === requiredPath || mountedPath.startsWith(`${requiredPath}/`)
    );

    if (!routeExists) {
      throw new Error(`Missing required API route: ${requiredPath}`);
    }
  });
}
