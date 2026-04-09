import { listRoutes as listDetailedRoutes } from "../debug/printRoutes.js";
export function listRoutes(app) {
    return Array.from(new Set(listDetailedRoutes(app).map((route) => route.path))).sort((a, b) => a.localeCompare(b));
}
