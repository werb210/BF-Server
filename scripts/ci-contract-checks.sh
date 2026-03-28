#!/usr/bin/env bash
set -euo pipefail

contract_files=(
  "src/lib/response.ts"
  "src/middleware/errorHandler.ts"
  "src/server/createServer.ts"
  "src/routes/auth.routes.ts"
  "src/routes/telephony/token.ts"
  "src/routes/application.ts"
  "src/routes/documents.ts"
  "src/routes/crm.ts"
)

res_json_matches=$(rg "res\\.json" "${contract_files[@]}" -n || true)
if [[ -n "$res_json_matches" ]]; then
  non_response=$(printf '%s\n' "$res_json_matches" | rg -v "src/lib/response.ts" || true)
  if [[ -n "$non_response" ]]; then
    echo "Raw res.json usage found outside src/lib/response.ts:"
    echo "$non_response"
    exit 1
  fi
fi

prisma_count=$(rg "new PrismaClient" src -n | wc -l | tr -d ' ')
if [[ "$prisma_count" != "1" ]]; then
  echo "Expected exactly 1 PrismaClient initialization, found $prisma_count"
  rg "new PrismaClient" src -n || true
  exit 1
fi

if rg "NODE_ENV" src/server src/routes src/middleware src/index.ts -n >/tmp/node_env_runtime_hits.txt; then
  echo "NODE_ENV runtime branching detected in runtime paths:"
  cat /tmp/node_env_runtime_hits.txt
  exit 1
fi

for path in "/auth" "/telephony" "/crm" "/applications" "/documents"; do
  if ! rg "app\.use\(\"$path\"" src/server/createServer.ts -n >/dev/null; then
    echo "Missing required route mount: $path"
    exit 1
  fi
done

if rg "localhost" src -n >/tmp/localhost_hits.txt; then
  echo "localhost references found in src/:"
  cat /tmp/localhost_hits.txt
  exit 1
fi

echo "Contract checks passed"
