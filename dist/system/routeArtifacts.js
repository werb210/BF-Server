import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listRouteInventory } from "../debug/printRoutes.js";
export const DEFAULT_ROUTE_ARTIFACT_PATH = "artifacts/server-routes.json";
function normalizeRoutePath(routePath) {
    if (!routePath || routePath === "//") {
        return "/";
    }
    const normalized = routePath.replace(/\/+/g, "/");
    return normalized.startsWith("/") ? normalized : `/${normalized}`;
}
function compareRoutes(a, b) {
    return (a.method.localeCompare(b.method) ||
        a.path.localeCompare(b.path) ||
        (a.source ?? "").localeCompare(b.source ?? ""));
}
function toKey(route) {
    return `${route.method} ${route.path} ${route.source ?? ""}`;
}
async function loadAppBuilder() {
    const { createApp } = await import("../app.js");
    return createApp;
}
export async function buildNormalizedRouteEntries() {
    const createApp = await loadAppBuilder();
    const app = await createApp();
    const routeInventory = listRouteInventory(app);
    const normalized = routeInventory.flatMap(({ routerBase, routes }) => routes.map((route) => ({
        method: route.method.toUpperCase(),
        path: normalizeRoutePath(route.path),
        source: routerBase || "/",
    })));
    const deduped = new Map();
    normalized.forEach((route) => {
        deduped.set(toKey(route), route);
    });
    return Array.from(deduped.values()).sort(compareRoutes);
}
export function renderNormalizedRouteLines(routes) {
    const lines = routes.map((route) => `${route.method} ${route.path}`);
    return Array.from(new Set(lines)).sort((a, b) => a.localeCompare(b));
}
export async function exportServerRoutesArtifact(outputPath = DEFAULT_ROUTE_ARTIFACT_PATH) {
    const routes = await buildNormalizedRouteEntries();
    const absolutePath = path.resolve(outputPath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
    return absolutePath;
}
