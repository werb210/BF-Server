import type { Application, Express } from "express";
import { logInfo } from "../observability/logger";

export type RouteEntry = { method: string; path: string };
export type RouteInventory = { routerBase: string; routes: RouteEntry[] };

type Layer = {
  route?: {
    path: string | string[];
    methods: Record<string, boolean>;
  };
  name?: string;
  handle?: { stack?: Layer[] };
  path?: string;
  regexp?: RegExp & { fast_slash?: boolean };
};

function fetchLayerPath(layer: Layer): string {
  if (typeof layer.path === "string") {
    return layer.path;
  }

  if (layer.regexp?.fast_slash) {
    return "";
  }

  const source = layer.regexp?.source;
  if (!source) {
    return "";
  }

  if (source === "^\\/?$") {
    return "";
  }

  let path = source
    .replace("^\\/", "/")
    .replace("\\/?(?=\\/|$)", "")
    .replace("(?=\\/|$)", "")
    .replace(/\\\//g, "/")
    .replace(/\$$/, "")
    .replace(/^\^/, "")
    .replace(/\(\?:\(\?=\\\/\|\$\)\)\?/, "")
    .replace(/\?$/, "");

  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  return path === "/" ? "" : path;
}

function joinPaths(prefix: string, suffix: string): string {
  const base = prefix === "/" ? "" : prefix;
  const tail = suffix === "/" ? "" : suffix;
  const combined = `${base}${tail}`;
  if (!combined) {
    return "/";
  }
  return combined.startsWith("/") ? combined : `/${combined}`;
}

function addRoute(
  routes: RouteEntry[],
  prefix: string,
  method: string,
  routePath: string
) {
  const fullPath = joinPaths(prefix, routePath);
  routes.push({ method, path: fullPath });
}

function walkStack(stack: Layer[], prefix: string, routes: RouteEntry[]) {
  stack.forEach((layer) => {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods);
      methods.forEach((method) => {
        paths.forEach((routePath) => addRoute(routes, prefix, method.toUpperCase(), routePath));
      });
      return;
    }

    if (layer.name === "router" && layer.handle?.stack) {
      const layerPath = fetchLayerPath(layer);
      const nextPrefix = joinPaths(prefix, layerPath);
      walkStack(layer.handle.stack, nextPrefix, routes);
    }
  });
}

function walkStackGrouped(
  stack: Layer[],
  prefix: string,
  groups: Map<string, RouteEntry[]>
) {
  stack.forEach((layer) => {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      const methods = Object.keys(layer.route.methods);
      const routerBase = prefix || "/";
      const routes = groups.get(routerBase) ?? [];
      methods.forEach((method) => {
        paths.forEach((routePath) =>
          addRoute(routes, prefix, method.toUpperCase(), routePath)
        );
      });
      groups.set(routerBase, routes);
      return;
    }

    if (layer.name === "router" && layer.handle?.stack) {
      const layerPath = fetchLayerPath(layer);
      const nextPrefix = joinPaths(prefix, layerPath);
      walkStackGrouped(layer.handle.stack, nextPrefix, groups);
    }
  });
}

export function listRoutes(app: Express | Application): RouteEntry[] {
  const routes: RouteEntry[] = [];
  const stack = (app as unknown as { _router?: { stack?: Layer[] } })._router?.stack;
  if (stack) {
    walkStack(stack, "", routes);
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return routes;
}

export function listRouteInventory(app: Express | Application): RouteInventory[] {
  const groups = new Map<string, RouteEntry[]>();
  const stack = (app as unknown as { _router?: { stack?: Layer[] } })._router?.stack;
  if (stack) {
    walkStackGrouped(stack, "", groups);
  }
  return Array.from(groups.entries())
    .map(([routerBase, routes]) => ({
      routerBase,
      routes: routes.sort(
        (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)
      ),
    }))
    .sort((a, b) => a.routerBase.localeCompare(b.routerBase));
}

export function printRoutes(app: Express | Application) {
  const routes = listRoutes(app);
  logInfo("routes_registered", { routes });
}
