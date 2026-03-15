#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACT_JSON="${REPO_ROOT}/artifacts/server-routes.json"
ARTIFACT_TXT="${REPO_ROOT}/artifacts/server-routes.txt"

cd "${REPO_ROOT}"

npm run --silent routes:export

node -e '
const fs = require("node:fs");
const artifactPath = process.argv[1];
const outputPath = process.argv[2];
const routes = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const lines = [...new Set((Array.isArray(routes) ? routes : []).map((route) => `${String(route.method || "").toUpperCase()} ${String(route.path || "")}`))]
  .sort((a, b) => a.localeCompare(b));
fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
' "${ARTIFACT_JSON}" "${ARTIFACT_TXT}"

echo "== BF-Server API Drift Check =="
echo
echo "Discovered server routes (${ARTIFACT_TXT}):"
cat "${ARTIFACT_TXT}"
echo
echo "Output files:"
echo "- ${ARTIFACT_JSON}"
echo "- ${ARTIFACT_TXT}"
echo
echo "API drift check complete."
