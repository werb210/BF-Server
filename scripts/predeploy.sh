#!/usr/bin/env bash
set -euo pipefail

npm run build || exit 1

echo "predeploy passed"
