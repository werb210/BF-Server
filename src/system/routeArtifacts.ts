import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listRouteInventory, type RouteEntry } from "../debug/printRoutes";
import { ENV } from "../config";

export type NormalizedRouteEntry = {
  method: string;
  path: string;
  source?: string;
};

export const DEFAULT_ROUTE_ARTIFACT_PATH = "artifacts/server-routes.json";

function normalizeRoutePath(routePath: string): string {
  if (!routePath || routePath === "//") {
    return "/";
  }

  const normalized = routePath.replace(/\/+/g, "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function compareRoutes(a: NormalizedRouteEntry, b: NormalizedRouteEntry): number {
  return (
    a.method.localeCompare(b.method) ||
    a.path.localeCompare(b.path) ||
    (a.source ?? "").localeCompare(b.source ?? "")
  );
}

function toKey(route: NormalizedRouteEntry): string {
  return `${route.method} ${route.path} ${route.source ?? ""}`;
}

async function loadAppBuilder() {
  if (!ENV.NODE_ENV) {
    ENV.NODE_ENV = "test";
  }
  if (!ENV.JWT_SECRET) {
    ENV.JWT_SECRET = "route-artifacts-secret";
  }
  ENV.OPENAI_API_KEY ??= "test-openai-key";
  ENV.TWILIO_ACCOUNT_SID ??= "ACtest";
  ENV.TWILIO_AUTH_TOKEN ??= "test-token";
  ENV.TWILIO_API_KEY_SID ??= "SKtest";
  ENV.TWILIO_API_SECRET ??= "test-secret";

  const { buildAppWithApiRoutes } = await import("../app.js");
  return buildAppWithApiRoutes;
}

export async function buildNormalizedRouteEntries(): Promise<NormalizedRouteEntry[]> {
  const buildAppWithApiRoutes = await loadAppBuilder();
  const app = buildAppWithApiRoutes();
  const routeInventory = listRouteInventory(app);

  const normalized = routeInventory.flatMap(({ routerBase, routes }) =>
    routes.map((route: RouteEntry) => ({
      method: route.method.toUpperCase(),
      path: normalizeRoutePath(route.path),
      source: routerBase || "/",
    }))
  );

  const deduped = new Map<string, NormalizedRouteEntry>();
  normalized.forEach((route) => {
    deduped.set(toKey(route), route);
  });

  return Array.from(deduped.values()).sort(compareRoutes);
}

export function renderNormalizedRouteLines(routes: NormalizedRouteEntry[]): string[] {
  const lines = routes.map((route) => `${route.method} ${route.path}`);
  return Array.from(new Set(lines)).sort((a, b) => a.localeCompare(b));
}

export async function exportServerRoutesArtifact(outputPath = DEFAULT_ROUTE_ARTIFACT_PATH): Promise<string> {
  const routes = await buildNormalizedRouteEntries();

  const absolutePath = path.resolve(outputPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
  return absolutePath;
}
