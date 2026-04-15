### Voice / Telephony

- The ONLY voice initialiser is `bootstrapVoice` from `@/telephony/bootstrapVoice`.
- The ONLY token fetch is `getVoiceToken` from `@/telephony/getVoiceToken`.
- The ONLY token endpoint is `/api/telephony/token`.
- Do NOT create new files under `src/services/` that initialise a Twilio Device.
- Do NOT hardcode `server.boreal.financial` or any base URL in service files.
- Do NOT use raw `fetch()` for API calls — use `api` from `@/api`.
- `src/services/twilio.ts` is DELETED. Do not recreate it.
- `src/services/voiceClient.ts` is DELETED. Do not recreate it.

### Route registration

- Routes MUST only be registered through `routeRegistry.ts` → `registerApiRouteMounts()`.
- `src/app.ts` must NOT contain `apiRouter.use()` calls for routers that are also in `API_ROUTE_MOUNTS`. Any new router goes in routeRegistry, not app.ts.
- Auth middleware (`requireAuth`) for a route group belongs in the router file itself or as a named middleware in routeRegistry, not in app.ts.
- The `_canonicalMount.ts` collision guard must remain in place and must not be bypassed.
- Never create a new route file for an endpoint that already exists in another route file.

### Rate limiting

- Never set `validate: { trustProxy: false }` on any rate limiter. `app.set('trust proxy', 1)` is already set. Adding trustProxy: false creates the ERR_ERL_INVALID_IP_ADDRESS crash on Azure.
- All rate limiters must use `keyGenerator: rateLimitKeyFromRequest` from `src/middleware/clientIp.ts`.

### Voice / Telephony (server)

- The canonical voice token endpoint is in `src/telephony/routes/telephonyRoutes.ts`.
- `src/routes/voiceToken.ts` is DELETED. Do not recreate it.
- Twilio env var for voice app is `TWILIO_VOICE_APP_SID` — never `TWILIO_APP_SID`.

### Database

- All new tables must have a migration in `migrations/` with the next sequential number.
- After adding a migration, verify it runs on next deploy by checking the migration tracker table (`schema_migrations` or equivalent).
- Never query a table in a service without confirming the migration for that table has been added to the migrations directory.

### Startup table verification

- `verifyRequiredTables()` in `src/index.ts` throws a fatal error if any listed table is missing. This will kill the server completely.
- NEVER add a table to `verifyRequiredTables()` unless its migration has already been applied to the production database and confirmed.
- Workflow for new tables:
  1. Write migration SQL in `migrations/NNN_name.sql`
  2. Deploy server — migration runner applies it on boot
  3. Confirm table exists in prod (check Azure DB)
  4. Only then add the table name to `verifyRequiredTables()`
- If a table is new and migration may not have run, use the warn-only pattern shown in `src/index.ts` — never the throwing pattern.

### No new token/telephony route files

- The ONLY telephony router is `src/telephony/routes/telephonyRoutes.ts`.
- `src/modules/telephony/token.route.ts` is DELETED. Do not recreate it.
- `src/routes/telephony/token.ts` is DELETED. Do not recreate it.
- `src/routes/telephony.routes.ts` is DELETED. Do not recreate it.
- Never create a file that returns a hardcoded fake token string.
