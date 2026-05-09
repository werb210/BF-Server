#!/bin/sh
# BI_SERVER_BLOCK_v65_DEPLOY_SPEED_AND_CLEANUP_v1
# Azure Linux App Service entrypoint. Oryx has already run npm install
# and npm run build during deploy (per .deployment SCM_DO_BUILD_DURING_DEPLOYMENT=true).
# This script just launches the compiled output.
set -e
echo "[startup.sh] $(date -u +%FT%TZ) build=${BUILD_TAG:-unknown} sha=${COMMIT_SHA:-unknown} node=$(node --version)"
echo "[startup.sh] PORT=${PORT:-unset} NODE_ENV=${NODE_ENV:-unset}"
cd /home/site/wwwroot
if [ ! -f "dist/index.js" ]; then
  echo "[startup.sh] FATAL: dist/index.js not found"
  ls -la
  exit 1
fi
echo "[startup.sh] launching node dist/index.js"
exec node dist/index.js
