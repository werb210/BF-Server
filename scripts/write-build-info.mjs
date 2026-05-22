#!/usr/bin/env node
// v611: write dist/_build-info.json with git SHA + timestamp.
// Runs as a postbuild step so the deployed dist/ carries provenance.
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

function safe(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

const fullSha = process.env.GITHUB_SHA || safe("git rev-parse HEAD") || "unknown";

const info = {
  sha: fullSha,
  shortSha: fullSha.slice(0, 7),
  branch: process.env.GITHUB_REF_NAME || safe("git rev-parse --abbrev-ref HEAD") || "unknown",
  timestamp: new Date().toISOString(),
  buildId: process.env.GITHUB_RUN_ID || null,
};

mkdirSync("dist", { recursive: true });
writeFileSync("dist/_build-info.json", JSON.stringify(info, null, 2));
console.log("[v611] wrote dist/_build-info.json", info);
