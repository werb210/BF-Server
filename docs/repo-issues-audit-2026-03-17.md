# Repository Issues Audit (Beyond OTP) — 2026-03-17

## Commands run

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npx vitest run tests/submissionRetrySafety.test.ts src/modules/applications/__tests__/processingStage.service.test.ts src/modules/applications/__tests__/processingStatus.service.test.ts src/test/ai.backend.test.ts`

## Additional issues identified

1. **Test database schema drift (broader than OTP): missing `users.silo` in active test setup.**
   - Failure surfaces in submission retry tests because code paths return/select `silo` while one setup path does not create that column.
   - `src/tests/setup.ts` creates `users` without `silo`.

2. **Broader schema bootstrap drift: missing `lenders` and related tables for many suites.**
   - Processing and AI backend tests fail with `relation "lenders" does not exist`.
   - This points to inconsistent schema setup across test entrypoints.

3. **A test file matched by Vitest has no test blocks (`src/db.test.ts`).**
   - File currently only re-exports from `dbTest`.
   - Causes hard failure: “No test suite found in file”.

4. **Twilio env variable naming is inconsistent across voice modules.**
   - Some modules require/use `TWILIO_TWIML_APP_SID`.
   - Env validation and voice service contracts use `TWILIO_VOICE_APP_SID`.
   - This can break voice token/call flows depending on which route/module is hit.

5. **Two parallel auth route implementations increase contract drift risk.**
   - `src/routes/auth.ts` and `src/modules/auth/auth.routes.ts` both implement OTP endpoints with different response envelopes and error mappings.
   - Legacy and canonical routes coexist, increasing maintenance/test mismatch risk.

## Suggested fixes (priority)

1. **P0: Unify test setup/migrations for all suites.**
   - Use one canonical test bootstrap that creates the full minimal schema used by all tests (users, lenders, submissions, processing tables, etc.).
   - Keep `users.silo` and any selected/returned columns in sync with repository queries.

2. **P0: Remove or convert `src/db.test.ts`.**
   - Either add explicit tests in `src/db.test.ts` or rename/move it so Vitest does not treat it as a test file.

3. **P1: Normalize Twilio voice env keys.**
   - Pick `TWILIO_VOICE_APP_SID` as canonical (already in env validation), then update modules still reading `TWILIO_TWIML_APP_SID` to fallback or migrate.

4. **P1: Collapse duplicate auth OTP handlers to one canonical surface.**
   - Keep one implementation and make legacy endpoints thin adapters to it.
   - Standardize response contracts to avoid repeated integration-test drift.
