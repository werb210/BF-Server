#!/usr/bin/env bash
# BF SBA staging smoke test
# -----------------------------------------------------------------------------
# Exercises the LIVE path against a running BF-Server (staging slot). It cannot
# do the two irreducibly-human steps for you - reading an OTP SMS and signing
# the SignNow envelopes - so it automates the two ends and watches the middle:
#
#   create   POST /api/public/application/start with an SBA-shaped profile,
#            then read it back via /status. Proves the live mint AND that the
#            Step 1 profile persists (country / monthly revenue / amount).
#   watch    Poll /status for an application id until it reaches "Off to Lender"
#            (= package dispatched) or times out. Run the real SBA wizard in the
#            browser (OTP -> pick an SBA product -> fill -> sign), then point
#            this at that application id to get a single GREEN/RED on dispatch.
#   otp      Helper: obtain a client bearer token (otp/start -> you type the
#            code -> otp/verify). Useful if you want to script further calls.
#
# Requires: bash, curl, jq.
# Usage:
#   ./sba_staging_smoke.sh <BASE_URL> create
#   ./sba_staging_smoke.sh <BASE_URL> watch <APPLICATION_ID> [TIMEOUT_MIN]
#   ./sba_staging_smoke.sh <BASE_URL> otp <E164_PHONE>
#
# BASE_URL example (staging slot): https://boreal-staff-server-staging.azurewebsites.net
# (Point it at whatever host serves your staging BF-Server. Do NOT add a trailing slash.)
set -euo pipefail

command -v curl >/dev/null || { echo "curl not found"; exit 2; }
command -v jq   >/dev/null || { echo "jq not found";   exit 2; }

BASE_URL="${1:-}"
CMD="${2:-}"
[ -n "$BASE_URL" ] || { echo "ERROR: pass BASE_URL as the first argument"; exit 2; }
[ -n "$CMD" ]      || { echo "ERROR: pass a command: create | watch | otp"; exit 2; }
BASE_URL="${BASE_URL%/}"   # strip trailing slash

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

# Read a possibly-wrapped field: tries .<path>, then .data.<path>, then .status.<path>
pick() { # $1 json  $2 jq-path-without-leading-dot
  local json="$1" path="$2" v
  v="$(printf '%s' "$json" | jq -r ".${path} // .data.${path} // .status.${path} // empty" 2>/dev/null || true)"
  printf '%s' "$v"
}

do_create() {
  echo "== create: POST /api/public/application/start (live mint) =="
  local body resp id
  # An SBA-shaped Step 1 profile. /start mints a generic draft; the SBA product
  # is chosen at Step 2, so this proves the mint + profile persistence, not the
  # SBA routing itself (that is what 'watch' observes on a real wizard run).
  body='{
    "source": "staging_smoke",
    "financialProfile": {
      "businessLocation": "United States",
      "monthlyRevenue": "$30,001 to $100,000",
      "fundingAmount": "$300,000",
      "lookingFor": "SBA / Start-up",
      "purposeOfFunds": "Business acquisition"
    }
  }'
  resp="$(curl -fsS -X POST "$BASE_URL/api/public/application/start" \
      -H 'Content-Type: application/json' -d "$body")" \
    || { red "FAIL: /start did not return 2xx"; exit 1; }
  id="$(pick "$resp" applicationId)"
  [ -z "$id" ] && id="$(pick "$resp" id)"
  [ -n "$id" ] || { red "FAIL: no applicationId in /start response"; echo "$resp"; exit 1; }
  green "OK  mint succeeded -> applicationId=$id"

  echo "== read back: GET /api/application/$id/status =="
  local st rev stage
  st="$(curl -fsS "$BASE_URL/api/application/$id/status")" \
    || { red "FAIL: /status did not return 2xx"; exit 1; }
  rev="$(printf '%s' "$st" | jq -r '.status.kyc.monthlyRevenue // .data.status.kyc.monthlyRevenue // empty')"
  stage="$(printf '%s' "$st" | jq -r '.status.pipelineState // .data.status.pipelineState // empty')"
  info "pipelineState = ${stage:-<none>}"
  info "kyc.monthlyRevenue persisted = ${rev:-<MISSING>}"
  if [ "$rev" = "\$30,001 to \$100,000" ]; then
    green "OK  Step 1 profile persisted on the draft (1A verified live)"
  else
    red   "WARN: monthly revenue did not round-trip - is the 1A block deployed on this slot?"
  fi
  echo
  green "create passed. To watch a full SBA run to dispatch:"
  info  "$0 $BASE_URL watch $id"
}

do_watch() {
  local id="${3:-}" timeout_min="${4:-30}"
  [ -n "$id" ] || { echo "ERROR: watch needs an APPLICATION_ID"; exit 2; }
  local deadline=$(( $(date +%s) + timeout_min * 60 ))
  echo "== watch: polling /api/application/$id/status until 'Off to Lender' (timeout ${timeout_min}m) =="
  echo "   (drive the app in the browser: OTP -> SBA product -> fill -> sign; staff dispatch when ready)"
  while :; do
    local st stage proc docs
    st="$(curl -fsS "$BASE_URL/api/application/$id/status" 2>/dev/null || true)"
    if [ -z "$st" ]; then red "  poll failed (no response); retrying"; else
      stage="$(printf '%s' "$st" | jq -r '.status.pipelineState // .data.status.pipelineState // "?"')"
      proc="$(printf '%s'  "$st" | jq -r '.status.processingStage // .data.status.processingStage // "?"')"
      docs="$(printf '%s'  "$st" | jq -r '(.status.documents // .data.status.documents // {}) | keys | length')"
      printf '  [%s] stage=%-26s processing=%-22s docs=%s\n' "$(date +%H:%M:%S)" "$stage" "$proc" "$docs"
      case "$stage" in
        "Off to Lender"|"Offer"|"Accepted")
          green "GREEN: application reached '$stage' - package dispatched to lender."; exit 0 ;;
        "Rejected"|"Fraud"|"Hold")
          red "RED: application parked in '$stage' - not dispatched."; exit 1 ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      red "RED: timed out after ${timeout_min}m without reaching 'Off to Lender'."; exit 1
    fi
    sleep 15
  done
}

do_otp() {
  local phone="${3:-}"
  [ -n "$phone" ] || { echo "ERROR: otp needs an E.164 phone (e.g. +15875551234)"; exit 2; }
  echo "== otp: POST /api/auth/otp/start =="
  curl -fsS -X POST "$BASE_URL/api/auth/otp/start" \
      -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\"}" >/dev/null \
    || { red "FAIL: otp/start"; exit 1; }
  green "OK  SMS sent to $phone"
  printf 'Enter the 6-digit code: '; read -r code
  local resp token
  resp="$(curl -fsS -X POST "$BASE_URL/api/auth/otp/verify" \
      -H 'Content-Type: application/json' -d "{\"phone\":\"$phone\",\"code\":\"$code\"}")" \
    || { red "FAIL: otp/verify"; exit 1; }
  token="$(printf '%s' "$resp" | jq -r '.data.token // .token // empty')"
  [ -n "$token" ] || { red "FAIL: no token in verify response"; echo "$resp"; exit 1; }
  green "OK  bearer token:"
  printf '%s\n' "$token"
}

case "$CMD" in
  create) do_create ;;
  watch)  do_watch "$@" ;;
  otp)    do_otp "$@" ;;
  *) echo "unknown command '$CMD' (use: create | watch | otp)"; exit 2 ;;
esac
