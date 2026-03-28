#!/usr/bin/env bash
set -euo pipefail

echo "======================================="
echo "🚀 FULL SYSTEM INTEGRATION TEST START"
echo "======================================="

ROOT_DIR=$(pwd)

find_repo_dir() {
  local name="$1"
  if [ -d "$ROOT_DIR/$name" ]; then
    echo "$ROOT_DIR/$name"
    return
  fi

  local found
  found=$(find "$ROOT_DIR" "$ROOT_DIR/.." -maxdepth 2 -type d -name "$name" 2>/dev/null | head -n 1 || true)
  if [ -n "$found" ]; then
    echo "$found"
    return
  fi

  echo ""
}

########################################
# 0. LOCATE REPOS
########################################

SERVER_DIR=$(find_repo_dir "BF-Server")
PORTAL_DIR=$(find_repo_dir "staff-portal")
CLIENT_DIR=$(find_repo_dir "client")
SERVER_BASE_URL="${SERVER_BASE_URL:-http://localhost:8080}"

[ -d "$SERVER_DIR" ] || { echo "❌ BF-Server not found"; exit 1; }
[ -d "$PORTAL_DIR" ] || { echo "❌ staff-portal not found"; exit 1; }
[ -d "$CLIENT_DIR" ] || { echo "❌ client not found"; exit 1; }

cleanup() {
  echo "🧹 Cleaning up background services..."
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${PORTAL_PID:-}" ] && kill "$PORTAL_PID" 2>/dev/null || true
  [ -n "${CLIENT_PID:-}" ] && kill "$CLIENT_PID" 2>/dev/null || true
}

trap cleanup EXIT

########################################
# 1. START SERVER
########################################

cd "$SERVER_DIR"
npm install
npm run build
nohup npm run start > server.log 2>&1 &
SERVER_PID=$!

echo "⏳ Waiting for server..."
for _ in {1..30}; do
  if curl -s "${SERVER_BASE_URL}/health" >/dev/null; then
    echo "✅ Server ready"
    break
  fi
  sleep 2
done

########################################
# 2. START PORTAL + CLIENT
########################################

cd "$PORTAL_DIR"
npm install
nohup npm run dev > portal.log 2>&1 &
PORTAL_PID=$!

cd "$CLIENT_DIR"
npm install
nohup npm run dev > client.log 2>&1 &
CLIENT_PID=$!

sleep 5

########################################
# 3. OTP START
########################################

echo "📲 OTP START..."

curl -c cookies.txt -X POST "${SERVER_BASE_URL}/api/auth/otp/start" \
  -H "Content-Type: application/json" \
  -d '{"phone":"+15555555555"}' || {
    echo "❌ OTP START FAILED"
    exit 1
  }

if [ -z "${OTP_CODE:-}" ]; then
  echo "⚠️ Enter OTP manually from Twilio logs"
  read -r -p "OTP: " OTP_CODE
fi

########################################
# 4. OTP VERIFY
########################################

echo "📲 OTP VERIFY..."

curl -b cookies.txt -c cookies.txt -X POST "${SERVER_BASE_URL}/api/auth/otp/verify" \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"+15555555555\",\"code\":\"$OTP_CODE\"}" || {
    echo "❌ OTP VERIFY FAILED"
    exit 1
  }

echo "✅ AUTHENTICATED"

########################################
# 5. CREATE APPLICATION (PUBLIC ENTRY)
########################################

echo "📄 Creating application..."

APP_RESPONSE=$(curl -b cookies.txt -s -X POST "${SERVER_BASE_URL}/api/public/application/start" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Integration Test Corp",
    "amount": 300000,
    "useOfFunds": "Working capital",
    "contact": {
      "name": "Agent Test",
      "email": "agent@test.com",
      "phone": "+15555555555"
    }
  }')

echo "$APP_RESPONSE"

APP_ID=$(echo "$APP_RESPONSE" | jq -r '.id // empty')

[ -n "$APP_ID" ] || {
  echo "❌ Application creation failed"
  exit 1
}

echo "✅ Application created: $APP_ID"

########################################
# 6. DOCUMENT UPLOAD
########################################

echo "📂 Uploading document..."

echo "test file" > /tmp/test.pdf

curl -b cookies.txt -X POST "${SERVER_BASE_URL}/api/documents/upload" \
  -F "file=@/tmp/test.pdf" \
  -F "applicationId=$APP_ID" \
  -F "category=bank_statement" || {
    echo "❌ Upload failed"
    exit 1
  }

echo "✅ Document uploaded"

########################################
# 7. VERIFY APPLICATION (PORTAL DATA PATH)
########################################

echo "📊 Fetching application..."

curl -b cookies.txt "${SERVER_BASE_URL}/api/applications/$APP_ID" | grep -q "Integration Test Corp" || {
  echo "❌ Application not visible"
  exit 1
}

echo "✅ Application visible"

########################################
# 8. TELEPHONY TEST
########################################

echo "📞 Testing outbound call..."

curl -b cookies.txt -X POST "${SERVER_BASE_URL}/api/telephony/outbound-call" \
  -H "Content-Type: application/json" \
  -d '{"to":"+15555555555"}' || {
    echo "❌ Call failed"
    exit 1
  }

echo "✅ Call triggered"

echo "======================================="
echo "✅ FULL SYSTEM TEST COMPLETE"
echo "======================================="

echo "Server PID: $SERVER_PID"
echo "Portal PID: $PORTAL_PID"
echo "Client PID: $CLIENT_PID"
