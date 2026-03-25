# OTP Service Test Findings (2026-03-17)

## What was executed

- Full test run via `npm test` (Vitest across repository).
- OTP-focused run via:
  - `npx jest run src/__tests__/auth.otp.verify.test.ts src/__tests__/auth/otp.start.test.ts src/__tests__/auth.otp.guard.test.ts tests/auth.verify-otp.route.test.ts tests/auth/otp.verify.contract.spec.ts tests/otpNormalization.test.ts`
  - `npx jest run src/tests/auth.otp.start.test.ts src/tests/auth.otp.flow.test.ts`

## Real OTP issues identified

1. **Test bootstrap is not loading the intended OTP/Twilio setup.**
   - `jest.config.ts` loads only `src/test/setup.ts` and `src/tests/setup.ts`.
   - The richer OTP/Twilio bootstrap (env defaults, schema bootstrap, `__twilioMocks`) is in `src/__tests__/setup.ts` and is currently not loaded by Vitest.
   - Impact: OTP tests fail with `Twilio mocks not initialized` and broader schema/env drift.

2. **Twilio mock shape is incompatible with code paths that instantiate Twilio as a constructor.**
   - Current setup mocks `twilio` with a plain default function, while telephony code uses `new Twilio(...)`.
   - Impact: OTP-adjacent suites fail at import time with `TypeError: ... default is not a constructor`.

3. **OTP tests are mixed between Jest and Vitest APIs and are partially stale.**
   - Several OTP tests call `jest.resetModules()` / `jest.isolateModules()` while the project test runner is Vitest.
   - Impact: hard failures like `ReferenceError: jest is not defined`.

4. **Contract drift between expected OTP routes/responses and current implementation.**
   - Tests expect `/api/auth/verify-otp` to return statuses/body contracts like `{ error: "invalid_code" }` with 401/400.
   - Current route behavior differs; some tests also mock out `auth.routes` entirely, which guarantees 404 for `/verify-otp` in that harness.
   - Compatibility routes are gated behind `ENABLE_COMPAT_ROUTES`, so old route contracts are not always mounted.

5. **Phone normalization contract drift.**
   - Tests expect invalid inputs (e.g. `"555"`) to throw.
   - Current normalization returns a normalized `+`-prefixed string and does not throw.
   - Impact: OTP validation expectations and helper behavior are inconsistent.

6. **Schema mismatch in test setup causes OTP upsert failures.**
   - Some OTP tests use `ON CONFLICT (phone_number)` but `src/tests/setup.ts` defines `users.phone_number` without a unique constraint.
   - Impact: execution errors like “There is no unique or exclusion constraint matching the ON CONFLICT specification”.

## Priority fix plan (fastest path)

1. **Unify test bootstrap first (P0).**
   - Use a single canonical Vitest setup that:
     - sets required env defaults for OTP/Twilio,
     - registers a constructor-compatible Twilio mock,
     - initializes `globalThis.__twilioMocks`,
     - creates OTP-required schema with all constraints used by tests.

2. **Standardize on Vitest APIs (P0).**
   - Replace all `jest.*` usages in OTP tests with `jest.*` equivalents.
   - Replace `require(...)` + isolate modules patterns with `await import(...)` or Vitest module mocking patterns.

3. **Pick one OTP API contract and align tests/routes (P0/P1).**
   - Decide whether `/api/auth/verify-otp` is primary or compatibility-only.
   - If compatibility is required, explicitly mount compat routes for tests (or test with `ENABLE_COMPAT_ROUTES=true`).
   - Normalize response envelope/status mappings and update tests accordingly.

4. **Clarify phone normalization/validation ownership (P1).**
   - Either:
     - make `normalizePhone` strict and throwing, or
     - keep normalization permissive and enforce strictness in schema validation.
   - Update tests to match the chosen behavior.

5. **Patch schema constraints in setup (P1).**
   - Ensure `users.phone_number` unique in all setup paths that support OTP upsert tests.

## Suggested immediate sequence for today

1. Switch Vitest setup to load the canonical OTP/Twilio setup file.
2. Swap in `src/test/twilioMock.ts`-style constructor mock globally.
3. Fix Jest/Vitest API usage in OTP-specific failing suites.
4. Re-run OTP-only suites; then re-run full auth suites.
5. After green OTP/auth, re-enable broader integration suites in batches.
