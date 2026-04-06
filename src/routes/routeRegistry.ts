import { Router } from "express";

export type ApiRoute = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  roles: string[];
};

export type ApiRouteMount = {
  path: string;
  router: Router;
};

export const API_ROUTE_MOUNTS: ApiRouteMount[] = [];
export const PORTAL_ROUTE_REQUIREMENTS: Pick<ApiRoute, "method" | "path">[] = [];
export const V1_REQUIRED_ROUTE_SURFACE = ["/api/health"] as const;
export const ROUTES: ApiRoute[] = [];

export function registerApiRouteMounts(app: Router): void {
  const apiRouter = Router();

  API_ROUTE_MOUNTS.forEach((entry) => {
    apiRouter.use(entry.path, entry.router);
  });

  app.use("/api", apiRouter);
}
