#!/usr/bin/env bash
set -euo pipefail

echo "===== SERVER CI LOOP START ====="

MAX="${MAX:-6}"
COUNT=1
PORT="${PORT:-3000}"
PHONE="${PHONE:-+15878881837}"
CODE="${CODE:-123456}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"
PID=""

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID" || true
  fi
}
trap cleanup EXIT

fix_typescript() {
  npx json -I -f tsconfig.json -e '
  this.compilerOptions.esModuleInterop = true;
  this.compilerOptions.skipLibCheck = true;
  ' || true
}

install_deps() {
  npm install || true
}

build_check() {
  npm run typecheck
}

start_server() {
  npm run build || true
  node dist/index.js > server.log 2>&1 &
  PID=$!

  for ((i=1; i<=WAIT_SECONDS; i++)); do
    if curl -s "http://localhost:${PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
      echo "SERVER UP"
      return 0
    fi

    if ! kill -0 "$PID" >/dev/null 2>&1; then
      echo "SERVER PROCESS EXITED"
      cat server.log
      return 1
    fi

    sleep 1
  done

  echo "SERVER FAILED"
  cat server.log
  cleanup
  return 1
}

test_api() {
  curl -s -X POST "http://localhost:${PORT}/api/auth/otp/send" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"${PHONE}\"}" >/dev/null

  VERIFY=$(curl -s -X POST "http://localhost:${PORT}/api/auth/otp/verify" \
    -H "Content-Type: application/json" \
    -d "{\"phone\":\"${PHONE}\",\"code\":\"${CODE}\"}")

  echo "$VERIFY" | grep -q '"ok":true'
}

while [ "$COUNT" -le "$MAX" ]; do
  echo "ATTEMPT $COUNT"

  install_deps
  fix_typescript

  if ! build_check; then
    echo "TYPE FAIL"
    COUNT=$((COUNT + 1))
    continue
  fi

  if ! start_server; then
    COUNT=$((COUNT + 1))
    continue
  fi

  if test_api; then
    echo "SERVER GREEN"
    exit 0
  fi

  cleanup
  COUNT=$((COUNT + 1))
done

echo "SERVER FAILED"
exit 1
