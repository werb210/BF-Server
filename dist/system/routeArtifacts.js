"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_ROUTE_ARTIFACT_PATH = void 0;
exports.buildNormalizedRouteEntries = buildNormalizedRouteEntries;
exports.renderNormalizedRouteLines = renderNormalizedRouteLines;
exports.exportServerRoutesArtifact = exportServerRoutesArtifact;
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const printRoutes_1 = require("../debug/printRoutes");
const config_1 = require("../config");
exports.DEFAULT_ROUTE_ARTIFACT_PATH = "artifacts/server-routes.json";
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
    if (!config_1.ENV.NODE_ENV) {
        config_1.ENV.NODE_ENV = "test";
    }
    if (!config_1.ENV.JWT_SECRET) {
        config_1.ENV.JWT_SECRET = "route-artifacts-secret";
    }
    config_1.ENV.OPENAI_API_KEY ?? (config_1.ENV.OPENAI_API_KEY = "test-openai-key");
    config_1.ENV.TWILIO_ACCOUNT_SID ?? (config_1.ENV.TWILIO_ACCOUNT_SID = "ACtest");
    config_1.ENV.TWILIO_AUTH_TOKEN ?? (config_1.ENV.TWILIO_AUTH_TOKEN = "test-token");
    config_1.ENV.TWILIO_API_KEY_SID ?? (config_1.ENV.TWILIO_API_KEY_SID = "SKtest");
    config_1.ENV.TWILIO_API_SECRET ?? (config_1.ENV.TWILIO_API_SECRET = "test-secret");
    const { buildAppWithApiRoutes } = await Promise.resolve().then(() => __importStar(require("../app.js")));
    return buildAppWithApiRoutes;
}
async function buildNormalizedRouteEntries() {
    const buildAppWithApiRoutes = await loadAppBuilder();
    const app = buildAppWithApiRoutes();
    const routeInventory = (0, printRoutes_1.listRouteInventory)(app);
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
function renderNormalizedRouteLines(routes) {
    const lines = routes.map((route) => `${route.method} ${route.path}`);
    return Array.from(new Set(lines)).sort((a, b) => a.localeCompare(b));
}
async function exportServerRoutesArtifact(outputPath = exports.DEFAULT_ROUTE_ARTIFACT_PATH) {
    const routes = await buildNormalizedRouteEntries();
    const absolutePath = node_path_1.default.resolve(outputPath);
    await (0, promises_1.mkdir)(node_path_1.default.dirname(absolutePath), { recursive: true });
    await (0, promises_1.writeFile)(absolutePath, `${JSON.stringify(routes, null, 2)}\n`, "utf8");
    return absolutePath;
}
