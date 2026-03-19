# BF Staff Server Targeted Test Report

Date: 2026-03-19 (UTC)

## Scope requested
1. Core health endpoints
2. Auth OTP flow
3. Session/cookie behavior
4. Protected routes
5. Schema validation
6. Critical integrations (Twilio mock, DB writes, unhandled rejections)

## Commands run
- `npx vitest --hookTimeout 120000 --testTimeout 120000 tests/auth.otp.test.ts src/__tests__/authMe.contract.test.ts src/__tests__/intakePortal.contract.test.ts src/__tests__/routeIntegrity.test.ts src/__tests__/runtime.codespaces.health.test.ts src/__tests__/auth.no500.test.ts src/__tests__/twilio.startup.test.ts`
- `node --import tsx scripts/tmp_probe.ts` (temporary probe script used during run; removed after execution)

## Findings by target

### 1) Core health
- `GET /api/health` returned **200** in direct probe.
- `GET /api/health/db` returned **500** with `{ "status": "db-failed" }` in direct probe.
- `runtime.codespaces.health` suite failed all endpoint checks due `Invalid URL` test harness issue (base URL resolution failure), so those results are inconclusive from that suite.

### 2) Auth system
- `POST /api/auth/otp/start` with `phone` returned **500** in direct probe due `ECONNREFUSED 127.0.0.1:5432`.
- Email-only payload for start endpoint returned **400** with `Missing phone` (expected behavior).
- `POST /api/auth/otp/verify` returned **500** in direct probe (upstream DB connectivity failure surfaced as Twilio error envelope).
- `GET /api/auth/me` without cookie returned **401** (expected).
- `GET /api/auth/me` with cookie could not be validated because OTP verify did not complete and no session cookie was established.

### 3) Session + cookies
- Could not verify `Set-Cookie` on OTP verify because verify flow failed with 500.
- Could not validate cookie flags (`Secure`, `SameSite=None`, domain) because no cookie was issued in failing flow.
- Cookie persistence across requests not testable in this run.

### 4) Protected routes
- Without auth:
  - `GET /api/applications` => **401**
  - `GET /api/lenders` => **401**
  - `GET /api/users` => **401**
- With auth was not validated successfully in direct probe, because auth bootstrap failed (OTP failures prevented obtaining session/token).
- Existing `intakePortal.contract` tests now show `/api/applications` calls returning **401** where the tests expect public `201`/`400` contract behavior; this is a contract regression signal.

### 5) Schema validation
- `POST /api/applications {}` currently returned **401** (auth block) instead of schema-level **400 validation** response in direct probe.
- `intakePortal.contract` also failed expecting validation contracts due auth enforcement occurring first.
- No HTML or unstructured 500 body observed on these validation-path attempts; responses were structured JSON.

### 6) Critical integrations
- Twilio-mocked integration suite (`tests/auth.otp.test.ts`) failed all tests, but root cause was execution context/app bootstrap mismatch (`Cannot read properties of undefined (reading 'address')`) rather than Twilio assertion mismatch.
- DB-related failures are present in direct probe (`ECONNREFUSED 127.0.0.1:5432`) and in `/api/health/db` status.
- `src/__tests__/auth.no500.test.ts` passed and confirmed malformed auth payloads return 400/401 (no 500 on those cases).
- No explicit unhandled promise rejection surfaced in the captured runs.

## Notable additional failures observed
- `routeIntegrity` fails due `pg-mem` uniqueness/index behavior (`users_email_key` null insert path), indicating test infra/data-model mismatch.
- `authMe.contract` has one failing assertion expecting DB query spy invocation (`querySpy` not called) while response status itself is 200.

## Overall risk summary
- Current environment indicates **critical auth path is blocked by DB connectivity** for OTP start/verify.
- `/api/health/db` failing is consistent with the auth failures and should be treated as a top blocker for server readiness.
- Contract drift is indicated for `/api/applications` accessibility/validation path (auth now gating routes expected to be public in contract tests).
