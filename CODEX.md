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
