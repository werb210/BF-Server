"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRoutes = listRoutes;
exports.listRouteInventory = listRouteInventory;
exports.printRoutes = printRoutes;
const logger_1 = require("../observability/logger");
function fetchLayerPath(layer) {
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
function joinPaths(prefix, suffix) {
    const base = prefix === "/" ? "" : prefix;
    const tail = suffix === "/" ? "" : suffix;
    const combined = `${base}${tail}`;
    if (!combined) {
        return "/";
    }
    return combined.startsWith("/") ? combined : `/${combined}`;
}
function addRoute(routes, prefix, method, routePath) {
    const fullPath = joinPaths(prefix, routePath);
    routes.push({ method, path: fullPath });
}
function walkStack(stack, prefix, routes) {
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
function walkStackGrouped(stack, prefix, groups) {
    stack.forEach((layer) => {
        if (layer.route) {
            const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
            const methods = Object.keys(layer.route.methods);
            const routerBase = prefix || "/";
            const routes = groups.get(routerBase) ?? [];
            methods.forEach((method) => {
                paths.forEach((routePath) => addRoute(routes, prefix, method.toUpperCase(), routePath));
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
function listRoutes(app) {
    const routes = [];
    const stack = app._router?.stack;
    if (stack) {
        walkStack(stack, "", routes);
    }
    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
    return routes;
}
function listRouteInventory(app) {
    const groups = new Map();
    const stack = app._router?.stack;
    if (stack) {
        walkStackGrouped(stack, "", groups);
    }
    return Array.from(groups.entries())
        .map(([routerBase, routes]) => ({
        routerBase,
        routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    }))
        .sort((a, b) => a.routerBase.localeCompare(b.routerBase));
}
function printRoutes(app) {
    const routes = listRoutes(app);
    (0, logger_1.logInfo)("routes_registered", { routes });
}
