# Server Full Test Report

Date: 2026-03-16
Repository: `boreal-staff-server` (`/workspace/BF-Server`)

## Commands Run

1. `npm install`
   - Result: success (`up to date in 10s`)

2. `npm run typecheck`
   - Run with timeout: `timeout 120s npm run typecheck`
   - Result: timed out after 120s while running `tsc --noEmit`

3. `npm run build`
   - Run with timeout: `timeout 180s npm run build`
   - Result: timed out after 180s while running `tsc`

4. `npm test`
   - Run with timeout: `timeout 120s npm test`
   - Result: timed out after 120s after Vitest started

5. Endpoint check: `POST /api/auth/otp/start`
   - Server start command used: `npm run dev`
   - Curl command:
     ```bash
     curl -X POST http://localhost:3000/api/auth/otp/start \
       -H "Content-Type: application/json" \
       -d '{"phone":"5878881837"}'
     ```
   - Result: `curl: (7) Failed to connect to localhost port 3000`
   - Dev log captured before termination:
     - npm script launched `tsx src/index.ts`
     - no readiness/listening output observed within wait window

## Notes

- The local environment emits `npm warn Unknown env config "http-proxy"` on each npm invocation.
- TypeScript-related commands did not complete within the applied time limits, so build/test and endpoint checks could not be fully validated end-to-end.
