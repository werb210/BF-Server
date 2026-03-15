import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROUTE_ARTIFACT_PATH,
  exportServerRoutesArtifact,
  renderNormalizedRouteLines,
  type NormalizedRouteEntry,
} from "../src/system/routeArtifacts";

const requiredRoutes = [
  "POST /api/auth/otp/start",
  "POST /api/auth/otp/verify",
  "GET /api/auth/me",
  "GET /health",
  "GET /api/telephony/token",
  "GET /api/applications/:id/documents",
  "GET /api/documents/:id/presign",
] as const;

describe("route artifact export", () => {
  it("exports a deterministic, non-empty server route artifact", async () => {
    const artifactPath = await exportServerRoutesArtifact(DEFAULT_ROUTE_ARTIFACT_PATH);
    expect(artifactPath).toBe(path.resolve(DEFAULT_ROUTE_ARTIFACT_PATH));

    const routes = JSON.parse((await readFile(artifactPath, "utf8"))) as NormalizedRouteEntry[];

    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThan(0);

    const normalizedLines = renderNormalizedRouteLines(routes);
    expect(normalizedLines.length).toBeGreaterThan(0);

    const sortedLines = [...normalizedLines].sort((a, b) => a.localeCompare(b));
    expect(normalizedLines).toEqual(sortedLines);

    requiredRoutes.forEach((route) => {
      expect(normalizedLines).toContain(route);
    });
  }, 20000);
});
