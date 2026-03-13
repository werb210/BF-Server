import type { Application, Express } from "express";
import { listRoutes as listDetailedRoutes } from "../debug/printRoutes";

export function listRoutes(app: Express | Application): string[] {
  return Array.from(new Set(listDetailedRoutes(app).map((route) => route.path))).sort(
    (a, b) => a.localeCompare(b)
  );
}
